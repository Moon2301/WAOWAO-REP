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
import { reportTaskProgress } from '../shared'

const execAsync = util.promisify(exec)

export async function handleVideoCharacterSwapTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-character-swap-split', taskId: job.data.taskId })
  const { projectId } = job.data
  const { videoUrl, chunkDuration: userChunkDuration } = job.data.payload as {
    videoUrl: string
    chunkDuration?: number
  }

  if (!videoUrl) {
    throw new Error('Thiếu tham số bắt buộc: videoUrl')
  }

  const baseChunkDuration = (userChunkDuration && userChunkDuration > 0) ? userChunkDuration : 5

  await reportTaskProgress(job, 5, { stage: 'init', message: 'Starting video split analysis. Downloading original video...' })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-swap-split-'))
  const originalVideoPath = path.join(tempDir, 'original.mp4')
  const originalAudioPath = path.join(tempDir, 'audio.aac')

  try {
    logger.info({ message: '1. Downloading original video', details: { videoUrl } })
    const videoBuffer = await downloadMediaValueToBuffer(videoUrl)
    fs.writeFileSync(originalVideoPath, videoBuffer)
    
    await reportTaskProgress(job, 15, { stage: 'download_video', message: 'Video downloaded. Probing video duration, frame rate, and audio track...' })
    await assertTaskActive(job, 'check_start')

    logger.info({ message: '2. Probing duration' })
    let originalDurationSec = 5
    try {
      const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${originalVideoPath}"`)
      const d = parseFloat(stdout.trim())
      if (!isNaN(d) && d > 0) originalDurationSec = d
    } catch {
      logger.warn({ message: 'Failed to probe original video duration, defaulting to 5s' })
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

    await reportTaskProgress(job, 30, { stage: 'probe_media', message: `Video duration: ${originalDurationSec.toFixed(1)}s. Analyzing optimal chunk splitting strategy...` })
    await assertTaskActive(job, 'after_probe')

    // If video is short enough for 1 chunk, no need to split
    if (originalDurationSec <= baseChunkDuration) {
      logger.info({ message: 'Video is short enough for 1 chunk, no splitting needed.' })
      // Register as MediaObject for browser playback
      let singleChunkUrl = videoUrl
      const singleKey = videoUrl.replace(/^\/+/, '')
      if (!singleKey.startsWith('http')) {
        const singleMediaRef = await ensureMediaObjectFromStorageKey(singleKey, { mimeType: 'video/mp4' })
        singleChunkUrl = singleMediaRef.url
      }
      await reportTaskProgress(job, 100, { stage: 'completed', message: 'Video is short enough for single chunk processing. Ready!' })
      return {
        splitOnly: true,
        isChunked: false,
        originalAudioUrl,
        originalDurationSec,
        baseChunkDuration,
        chunks: [{
          originalUrl: singleChunkUrl,
          index: 0,
          duration: originalDurationSec,
        }]
      }
    }

    // Calculate chunk definitions
    const chunksCount = Math.ceil(originalDurationSec / baseChunkDuration)
    const chunkDefs: { index: number; start: number; duration: number }[] = []

    for (let i = 0; i < chunksCount; i++) {
      const start = i * baseChunkDuration
      let duration = baseChunkDuration
      if (start + duration > originalDurationSec) {
        duration = originalDurationSec - start
      }
      
      // If the last chunk is too short (<2s) and it's not the only chunk, merge it with the previous one
      if (duration < 2 && chunkDefs.length > 0) {
        chunkDefs[chunkDefs.length - 1].duration += duration
      } else {
        chunkDefs.push({ index: i, start, duration })
      }
    }

    logger.info({ message: '4. Splitting video', details: { chunks: chunkDefs } })

    const chunkResults: { originalUrl: string, index: number, duration: number }[] = []

    for (const def of chunkDefs) {
      const chunkPath = path.join(tempDir, `chunk_${def.index}.mp4`)
      await execAsync(`ffmpeg -y -i "${originalVideoPath}" -ss ${def.start} -t ${def.duration} -c:v libx264 -preset fast -pix_fmt yuv420p -movflags +faststart "${chunkPath}"`)
      
      const chunkBuffer = fs.readFileSync(chunkPath)
      const chunkKey = generateUniqueKey(`projects/${projectId}/videos/chunks/`, 'mp4')
      await uploadObject(chunkBuffer, chunkKey, 3, 'video/mp4')
      
      // Register as MediaObject so it can be served via /m/ route with Range support
      const mediaRef = await ensureMediaObjectFromStorageKey(chunkKey, {
        mimeType: 'video/mp4',
        sizeBytes: chunkBuffer.length,
      })
      
      chunkResults.push({
        originalUrl: mediaRef.url,  // /m/{publicId} — browser-playable
        index: def.index,
        duration: def.duration,
      })
    }
    
    await reportTaskProgress(job, 100, { stage: 'completed', message: `Successfully split video into ${chunkDefs.length} chunks for parallel AI generation!` })
    
    // Return split info only — do NOT submit chunk tasks
    return {
      splitOnly: true,
      isChunked: true,
      originalAudioUrl,
      originalDurationSec,
      baseChunkDuration,
      chunks: chunkResults,
    }

  } finally {
    logger.info({ message: 'Cleaning up temp files' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
