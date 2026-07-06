import fs from 'fs'
import path from 'path'
import os from 'os'
import util from 'util'
import { exec } from 'child_process'
import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import { assertTaskActive } from '../utils'
import { uploadObject, getObjectBuffer, generateUniqueKey } from '@/lib/storage'
import { downloadMediaValueToBuffer } from '@/lib/media/download'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { enqueueFrameProcessingTasks } from '@/lib/video-frame/enqueue-frame-processing'
import { reportTaskProgress } from '../shared'

const execAsync = util.promisify(exec)

export async function handleVideoFrameExtractTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-frame-extract', taskId: job.data.taskId })
  const { projectId, userId } = job.data
  const {
    videoUrl,
    targetFps = 8,
    processingMode,
    prompt,
    referenceImageUrl,
    modelId,
    artStyle,
    temporalMode = 'none',
    consistencySeed,
    extractOnly = false,
  } = job.data.payload as {
    videoUrl: string
    targetFps?: number
    processingMode: 'img2img' | 'v2v'
    prompt?: string
    referenceImageUrl?: string
    modelId?: string
    artStyle?: string
    temporalMode?: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
    consistencySeed?: number
    extractOnly?: boolean
  }

  if (!videoUrl) {
    throw new Error('Thiếu tham số bắt buộc: videoUrl')
  }

  await reportTaskProgress(job, 5, { stage: 'download_video', message: 'Downloading original video from storage...' })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frame-extract-'))
  const originalVideoPath = path.join(tempDir, 'original.mp4')
  const originalAudioPath = path.join(tempDir, 'audio.aac')
  const framesDir = path.join(tempDir, 'frames')
  fs.mkdirSync(framesDir)

  try {
    logger.info({ message: '1. Downloading original video', details: { videoUrl } })
    const videoBuffer = await downloadMediaValueToBuffer(videoUrl)
    fs.writeFileSync(originalVideoPath, videoBuffer)
    
    await reportTaskProgress(job, 15, { stage: 'probe_media', message: 'Probing video duration, frame rate, and extracting audio...' })
    await assertTaskActive(job, 'check_start')

    logger.info({ message: '2. Probing duration and fps' })
    let originalDurationSec = 5
    let originalFps = 30
    try {
      const { stdout: durStdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${originalVideoPath}"`)
      const d = parseFloat(durStdout.trim())
      if (!isNaN(d) && d > 0) originalDurationSec = d

      const { stdout: fpsStdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${originalVideoPath}"`)
      const [num, den] = fpsStdout.trim().split('/')
      if (num && den) {
        const fps = parseFloat(num) / parseFloat(den)
        if (!isNaN(fps) && fps > 0) originalFps = fps
      }
    } catch {
      logger.warn({ message: 'Failed to probe video details, using defaults' })
    }

    logger.info({ message: '3. Extracting original audio' })
    let hasAudio = false
    try {
      await execAsync(`ffmpeg -i "${originalVideoPath}" -vn -acodec copy "${originalAudioPath}"`)
      hasAudio = fs.existsSync(originalAudioPath) && fs.statSync(originalAudioPath).size > 0
    } catch {
      logger.warn({ message: 'No audio stream found or extraction failed, proceeding without audio' })
    }

    let originalAudioUrl: string | undefined = undefined
    if (hasAudio) {
      const audioBuffer = fs.readFileSync(originalAudioPath)
      const audioKey = generateUniqueKey(`projects/${projectId}/videos/audio/`, 'aac')
      await uploadObject(audioBuffer, audioKey, 3, 'audio/aac')
      originalAudioUrl = `/${audioKey}`
    }

    await reportTaskProgress(job, 30, { stage: 'extract_frames', message: `Extracting frames at ${targetFps} fps using FFmpeg...` })
    await assertTaskActive(job, 'after_audio')

    logger.info({ message: `4. Extracting frames at ${targetFps} fps` })
    const framePattern = path.join(framesDir, 'frame_%06d.jpg')
    await execAsync(`ffmpeg -y -i "${originalVideoPath}" -vf "fps=${targetFps}" -q:v 2 "${framePattern}"`)

    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort()
    const totalFrames = frameFiles.length
    
    if (totalFrames === 0) {
      throw new Error('Không thể extract frames từ video')
    }

    logger.info({ message: `Extracted ${totalFrames} frames` })
    await reportTaskProgress(job, 50, { stage: 'upload_frames', message: `Extracted ${totalFrames} frames. Uploading to cloud storage...` })
    await assertTaskActive(job, 'after_extract')

    // Optional: Motion vector extraction
    let motionDataKey: string | undefined = undefined
    if (temporalMode === 'motion_compensated') {
      logger.info({ message: '5. Extracting motion vectors' })
      const motionDataPath = path.join(tempDir, 'motion_data.txt')
      try {
        await execAsync(`ffmpeg -y -i "${originalVideoPath}" -vf "fps=${targetFps},mestimate=epzs:mb_size=16" -f rawvideo -pix_fmt rgb24 /dev/null -an -f framemd5 "${motionDataPath}"`)
        const motionBuffer = fs.readFileSync(motionDataPath)
        motionDataKey = generateUniqueKey(`projects/${projectId}/videos/motion/`, 'txt')
        await uploadObject(motionBuffer, motionDataKey, 3, 'text/plain')
      } catch (err) {
        logger.warn({ message: 'Failed to extract motion vectors', error: err })
        // Fallback to prev_frame_ref if motion extraction fails? Or just continue without it and let handler deal with it
      }
    }

    logger.info({ message: '6. Uploading frames to storage' })
    const frameKeys: string[] = []
    for (let i = 0; i < frameFiles.length; i++) {
      const file = frameFiles[i]
      const buffer = fs.readFileSync(path.join(framesDir, file))
      const key = generateUniqueKey(`projects/${projectId}/videos/frames/`, 'jpg')
      await uploadObject(buffer, key, 3, 'image/jpeg')
      const mediaRef = await ensureMediaObjectFromStorageKey(key, {
        mimeType: 'image/jpeg',
        sizeBytes: buffer.length,
      })
      frameKeys.push(mediaRef.storageKey || key)
      
      if (i % 10 === 0) {
        await reportTaskProgress(job, 50 + Math.floor((i / totalFrames) * 30), { stage: 'upload_frames', message: `Uploading extracted frames (${i}/${totalFrames})...` })
        await assertTaskActive(job, 'uploading_frames')
      }
    }

    const taskLocale = job.data.locale || 'en'

    if (extractOnly) {
      await reportTaskProgress(job, 100, {
        stage: 'extract_completed',
        message: `Extracted ${totalFrames} frames. Ready for preview.`,
      })

      return {
        totalFrames,
        originalFps,
        targetFps,
        originalDurationSec,
        audioUrl: originalAudioUrl,
        frameKeys,
        motionData: motionDataKey,
        extractOnly: true,
      }
    }

    if (!modelId) {
      throw new Error('Thiếu tham số bắt buộc: modelId')
    }

    logger.info({ message: '7. Creating and enqueuing child tasks' })
    await reportTaskProgress(job, 85, { stage: 'create_tasks', message: `Enqueuing ${totalFrames} parallel frame processing tasks...` })

    const { frameTaskIds, mergeTaskId } = await enqueueFrameProcessingTasks({
      userId,
      projectId,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      locale: taskLocale,
      frameKeys,
      audioUrl: originalAudioUrl,
      targetFps,
      originalDurationSec,
      processingMode,
      prompt,
      referenceImageUrl,
      modelId,
      artStyle,
      temporalMode,
      consistencySeed,
      motionDataKey,
    })

    await reportTaskProgress(job, 100, { stage: 'completed', message: 'Frame extraction and distribution completed successfully!' })

    return {
      totalFrames,
      originalFps,
      targetFps,
      originalDurationSec,
      audioUrl: originalAudioUrl,
      frameKeys,
      motionData: motionDataKey,
      frameTaskIds,
      mergeTaskId,
    }

  } finally {
    logger.info({ message: 'Cleaning up temp files' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
