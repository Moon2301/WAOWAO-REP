import fs from 'fs'
import path from 'path'
import os from 'os'
import util from 'util'
import { exec } from 'child_process'
import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import {
  assertTaskActive,
  resolveImageSourceFromGeneration,
  resolveVideoSourceFromGeneration,
  uploadVideoSourceToCos,
} from '../utils'
import { downloadMediaValueToBuffer, resolveCanonicalStorageKey } from '@/lib/media/download'
import { analyzeVideoToPrompt } from '@/lib/llm/video-analyze'
import { getProviderConfig } from '@/lib/api-config'
import { getProjectModelConfig } from '@/lib/config-service'
import { getSignedUrl, uploadObject, generateUniqueKey } from '@/lib/storage'
import { reportTaskProgress } from '../shared'
import { snapVideoDurationForModel } from '@/lib/model-capabilities/video-duration-snap'
import {
  buildChunkVideoGenerationPrompt,
  buildVideoAnalyzePrompt,
  CHUNK_FIRST_FRAME_SWAP_PROMPT,
} from '@/lib/video-character-swap/prompts'

const execAsync = util.promisify(exec)

async function resolveStartImageUrl(
  source: string,
  projectId: string,
): Promise<string> {
  if (source.startsWith('data:') || source.startsWith('http://') || source.startsWith('https://')) {
    const buffer = source.startsWith('data:')
      ? Buffer.from(source.substring(source.indexOf(';base64,') + 8), 'base64')
      : await downloadMediaValueToBuffer(source)
    const key = generateUniqueKey(`projects/${projectId}/videos/chunk_start_frames/`, 'jpg')
    await uploadObject(buffer, key, 3, 'image/jpeg')
    return getSignedUrl(key, 3600)
  }
  const key = source.replace(/^\/+/, '')
  return getSignedUrl(key, 3600)
}

export async function handleVideoCharacterSwapChunkTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-character-swap-chunk', taskId: job.data.taskId })
  const { userId, projectId } = job.data
  const {
    chunkOriginalUrl,
    targetImageUrl,
    modelId,
    prompt: userPrompt,
    characterHint,
    baseChunkDuration,
    duration,
    resolution,
    artStyle,
  } = job.data.payload as {
    chunkOriginalUrl: string
    targetImageUrl: string
    modelId: string
    prompt?: string
    characterHint?: string
    baseChunkDuration?: number
    duration?: number
    resolution?: string
    artStyle?: string
  }

  if (!chunkOriginalUrl || !targetImageUrl || !modelId) {
    throw new Error('Thiếu tham số bắt buộc cho chunk: chunkOriginalUrl, targetImageUrl, hoặc modelId')
  }

  const passthrough = (job.data.payload as { passthrough?: boolean }).passthrough === true
  if (passthrough) {
    await reportTaskProgress(job, 100, {
      stage: 'completed',
      message: 'Skipped — using original chunk video (no character swap).',
    })
    const key = (await resolveCanonicalStorageKey(chunkOriginalUrl)) || chunkOriginalUrl.replace(/^\/+/, '')
    return {
      videoUrl: key,
      passthrough: true,
    }
  }

  await reportTaskProgress(job, 10, { stage: 'init', message: 'Starting chunk processing. Downloading original video chunk...' })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-swap-chunk-'))
  const originalChunkPath = path.join(tempDir, 'chunk_original.mp4')

  try {
    logger.info({ message: '1. Downloading chunk video', details: { chunkOriginalUrl } })
    const videoBuffer = await downloadMediaValueToBuffer(chunkOriginalUrl)
    fs.writeFileSync(originalChunkPath, videoBuffer)

    await reportTaskProgress(job, 25, { stage: 'download_chunk', message: 'Chunk downloaded. Analyzing motion with Gemini...' })
    await assertTaskActive(job, 'after_download')

    let motionDescription = userPrompt?.trim() || ''
    if (!motionDescription) {
      logger.info({ message: '2. Analyzing chunk motion with Gemini' })
      motionDescription = await analyzeVideoToPrompt(
        originalChunkPath,
        userId,
        characterHint,
        buildVideoAnalyzePrompt(characterHint),
      )
      logger.info({ message: 'Gemini motion analysis completed', details: { motionDescription } })
    } else {
      logger.info({ message: '2. Using user motion prompt', details: { motionDescription } })
    }

    await reportTaskProgress(job, 35, { stage: 'prepare_start_frame', message: 'Preparing start frame: compositing reference character onto original scene...' })

    const firstFramePath = path.join(tempDir, 'first_frame.jpg')
    await execAsync(`ffmpeg -y -i "${originalChunkPath}" -vframes 1 -q:v 2 "${firstFramePath}"`)
    const firstFrameKey = generateUniqueKey(`projects/${projectId}/videos/chunk_frames/`, 'jpg')
    await uploadObject(fs.readFileSync(firstFramePath), firstFrameKey, 3, 'image/jpeg')
    const firstFrameUrl = getSignedUrl(firstFrameKey, 3600)
    const targetFrameUrl = await resolveStartImageUrl(targetImageUrl, projectId)

    let startImageUrl = targetFrameUrl
    const projectConfig = await getProjectModelConfig(projectId, userId)
    if (projectConfig.editModel) {
      logger.info({ message: '2b. Swapping character onto first frame via edit model', details: { editModel: projectConfig.editModel } })
      const swappedSource = await resolveImageSourceFromGeneration(job, {
        userId,
        modelId: projectConfig.editModel,
        prompt: CHUNK_FIRST_FRAME_SWAP_PROMPT,
        options: {
          referenceImages: [firstFrameUrl, targetFrameUrl],
        },
        pollProgress: { start: 36, end: 42 },
      })
      startImageUrl = await resolveStartImageUrl(swappedSource, projectId)
    } else {
      logger.warn({ message: 'No editModel in project — using reference image as start frame (may look like a portrait at clip start). Configure editModel for better results.' })
    }

    const finalPrompt = buildChunkVideoGenerationPrompt({
      motionDescription,
      artStyle,
      characterHint,
    })

    await reportTaskProgress(job, 45, { stage: 'prompt_ready', message: `Prompt ready. Generating video with ${modelId}...` })
    await assertTaskActive(job, 'after_prompt')

    logger.info({ message: '3. Generating chunk video (i2v)', details: { finalPrompt: finalPrompt.substring(0, 200) } })

    const rawChunkDuration = typeof duration === 'number' ? duration : baseChunkDuration
    const snappedDuration = snapVideoDurationForModel(
      modelId,
      typeof rawChunkDuration === 'number' && Number.isFinite(rawChunkDuration) ? rawChunkDuration : 5,
    )

    const result = await resolveVideoSourceFromGeneration(job, {
      userId,
      modelId,
      imageUrl: startImageUrl,
      options: {
        prompt: finalPrompt,
        duration: snappedDuration,
        resolution,
        generationMode: 'normal',
      },
      pollProgress: { start: 50, end: 95 },
    })

    logger.info({ message: 'Downloading generated chunk to storage' })
    let downloadHeaders: Record<string, string> | undefined
    if (result.downloadHeaders) {
      downloadHeaders = result.downloadHeaders
    } else if (result.url.includes('generativelanguage.googleapis.com/') && result.url.includes(':download')) {
      const { apiKey } = await getProviderConfig(userId, 'google')
      downloadHeaders = { 'x-goog-api-key': apiKey }
    }

    const cosKey = await uploadVideoSourceToCos(result.url, 'video-swap-chunk', job.data.taskId, downloadHeaders)

    await reportTaskProgress(job, 100, { stage: 'completed', message: 'Chunk video character swap generated successfully!' })

    return {
      videoUrl: cosKey,
      actionPrompt: motionDescription,
      finalPrompt,
      downloadHeaders: result.downloadHeaders,
    }

  } finally {
    logger.info({ message: 'Cleaning up temp files' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
