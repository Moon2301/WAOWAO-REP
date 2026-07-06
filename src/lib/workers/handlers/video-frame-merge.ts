import fs from 'fs'
import path from 'path'
import os from 'os'
import util from 'util'
import { exec } from 'child_process'
import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import { assertTaskActive } from '../utils'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import { downloadMediaValueToBuffer } from '@/lib/media/download'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { prisma } from '@/lib/prisma'
import { TASK_STATUS } from '@/lib/task/types'
import { reportTaskProgress } from '../shared'
import { saveFbfResultVideoByMediaId } from '@/lib/video-frame/fbf-result-persistence'

const execAsync = util.promisify(exec)

export async function handleVideoFrameMergeTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-frame-merge', taskId: job.data.taskId })
  const { projectId } = job.data
  const {
    audioUrl,
    targetFps = 8,
    originalDurationSec,
    totalFrames,
  } = job.data.payload as {
    audioUrl?: string
    targetFps: number
    originalDurationSec: number
    totalFrames: number
  }

  await reportTaskProgress(job, 5, { stage: 'init', message: 'Starting frame reassembly. Verifying dependencies and fetching processed frames from DB...' })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frame-merge-'))
  const framesDir = path.join(tempDir, 'frames')
  fs.mkdirSync(framesDir)

  try {
    logger.info({ message: '1. Fetching processed frames from DB' })
    
    // The run-runtime ensures this task only runs when all dependencies are COMPLETED
    
    const payload = job.data.payload as { dependsOn?: string } | undefined
    if (!payload || !payload.dependsOn) {
      throw new Error(`Merge task ${job.data.taskId} missing dependsOn in payload`)
    }

    const frameTaskIds = payload.dependsOn.split(',')
    
    // Fetch outputs of all frame tasks
    const completedFrameTasks = await prisma.task.findMany({
      where: {
        id: { in: frameTaskIds },
        status: TASK_STATUS.COMPLETED
      },
      select: { id: true, result: true }
    })
    
    if (completedFrameTasks.length !== frameTaskIds.length) {
      const foundIds = completedFrameTasks.map(t => t.id)
      const missingIds = frameTaskIds.filter(id => !foundIds.includes(id))
      logger.error({ message: 'Missing frame outputs', frameTaskIds, foundIds, missingIds })
      throw new Error(`Thiếu frame outputs. Chờ ${frameTaskIds.length}, có ${completedFrameTasks.length}. Missing: ${missingIds.join(', ')}`)
    }
    
    const processedFrames: { frameIndex: number, url: string }[] = []
    for (const fTask of completedFrameTasks) {
      const resultObj = fTask.result as { processedImageUrl?: string; processedFrameKey?: string; frameIndex?: number } | undefined
      const processedUrl = resultObj?.processedImageUrl || resultObj?.processedFrameKey
      if (resultObj && processedUrl && resultObj.frameIndex !== undefined) {
        processedFrames.push({
          frameIndex: resultObj.frameIndex,
          url: processedUrl
        })
      }
    }
    
    if (processedFrames.length !== totalFrames) {
      throw new Error(`Số lượng frames không khớp. Lấy được ${processedFrames.length}, mong đợi ${totalFrames}`)
    }
    
    // Sort by index
    processedFrames.sort((a, b) => a.frameIndex - b.frameIndex)
    
    await reportTaskProgress(job, 15, { stage: 'download_frames', message: `Downloading ${processedFrames.length} processed frames from cloud storage...` })

    logger.info({ message: '2. Downloading processed frames' })
    
    for (const frame of processedFrames) {
      const buffer = await downloadMediaValueToBuffer(frame.url)
      const fileName = `frame_${String(frame.frameIndex).padStart(6, '0')}.jpg`
      fs.writeFileSync(path.join(framesDir, fileName), buffer)
      
      if (frame.frameIndex % 10 === 0) {
        await assertTaskActive(job, 'downloading_frames')
      }
    }
    
    await reportTaskProgress(job, 40, { stage: 'encode_video', message: `Encoding ${processedFrames.length} frames into H.264 video at ${targetFps} fps...` })

    logger.info({ message: '3. Merging frames to video' })
    const videoOnlyPath = path.join(tempDir, 'video_only.mp4')
    const framePattern = path.join(framesDir, 'frame_%06d.jpg')
    
    // H.264 encode from image sequence
    await execAsync(`ffmpeg -y -framerate ${targetFps} -i "${framePattern}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart "${videoOnlyPath}"`)
    
    await reportTaskProgress(job, 70, { stage: 'merge_audio', message: 'Video encoding finished. Remuxing original audio soundtrack...' })
    await assertTaskActive(job, 'after_merge')

    logger.info({ message: '4. Merging audio (if any)' })
    const finalOutputPath = path.join(tempDir, 'final_output.mp4')
    
    if (audioUrl) {
      const audioPath = path.join(tempDir, 'audio.aac')
      const audioBuffer = await downloadMediaValueToBuffer(audioUrl)
      fs.writeFileSync(audioPath, audioBuffer)
      
      await execAsync(`ffmpeg -y -i "${videoOnlyPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${finalOutputPath}"`)
    } else {
      // Just copy videoOnly to finalOutput
      fs.copyFileSync(videoOnlyPath, finalOutputPath)
    }

    await reportTaskProgress(job, 85, { stage: 'upload_video', message: 'Uploading final reassembled video to cloud storage...' })
    await assertTaskActive(job, 'after_audio_merge')

    logger.info({ message: '5. Uploading final video to storage' })
    const finalBuffer = fs.readFileSync(finalOutputPath)
    const finalKey = generateUniqueKey(`projects/${projectId}/videos/processed/`, 'mp4')
    await uploadObject(finalBuffer, finalKey, 3, 'video/mp4')
    
    const mediaRef = await ensureMediaObjectFromStorageKey(finalKey, {
      mimeType: 'video/mp4',
      sizeBytes: finalBuffer.length,
    })

    await saveFbfResultVideoByMediaId(projectId, mediaRef.id)

    await reportTaskProgress(job, 100, { stage: 'completed', message: 'Final video character swap merged and ready!' })

    return {
      videoUrl: mediaRef.url,
      targetFps,
      totalFrames,
    }

  } finally {
    logger.info({ message: 'Cleaning up temp files' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
