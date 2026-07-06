import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import { getSignedUrl } from '@/lib/storage'
import { resolveCanonicalStorageKey } from '@/lib/media/download'
import { detectCharacterInFrame } from '@/lib/llm/frame-character-detect'
import { reportTaskProgress } from '../shared'

export async function handleVideoFrameClassifyTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-frame-classify', taskId: job.data.taskId })
  const { userId } = job.data
  const { frameKeys, characterHint, referenceImageUrl } = job.data.payload as {
    frameKeys: string[]
    characterHint?: string
    referenceImageUrl?: string
  }

  if (!Array.isArray(frameKeys) || frameKeys.length === 0) {
    throw new Error('frameKeys is required for classification')
  }

  let referenceUrl: string | undefined
  if (referenceImageUrl) {
    const refKey = await resolveCanonicalStorageKey(referenceImageUrl)
    referenceUrl = refKey ? getSignedUrl(refKey, 3600) : referenceImageUrl
  }

  const classifications: Array<{ index: number; hasCharacter: boolean; reason?: string }> = []

  for (let i = 0; i < frameKeys.length; i++) {
    const frameKey = frameKeys[i]
    const storageKey = await resolveCanonicalStorageKey(frameKey)
    const frameUrl = storageKey ? getSignedUrl(storageKey, 3600) : frameKey

    const progress = Math.floor(10 + ((i + 1) / frameKeys.length) * 85)
    await reportTaskProgress(job, progress, {
      stage: 'classify_frame',
      message: `Classifying frame ${i + 1}/${frameKeys.length}...`,
    })

    try {
      const result = await detectCharacterInFrame(frameUrl, userId, {
        characterHint,
        referenceImageUrl: referenceUrl,
      })
      classifications.push({ index: i, hasCharacter: result.hasCharacter, reason: result.reason })
    } catch (error) {
      logger.warn({
        message: 'Frame classification failed, defaulting to process',
        details: { index: i, error: error instanceof Error ? error.message : String(error) },
      })
      classifications.push({ index: i, hasCharacter: true, reason: 'classification_error_fallback' })
    }
  }

  await reportTaskProgress(job, 100, { stage: 'completed', message: 'Frame classification completed' })

  const processCount = classifications.filter((c) => c.hasCharacter).length
  logger.info({
    message: 'Classification summary',
    details: { total: frameKeys.length, processCount, skipCount: frameKeys.length - processCount },
  })

  return { classifications }
}
