import fs from 'fs'
import path from 'path'
import os from 'os'
import util from 'util'
import { exec } from 'child_process'
import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import { assertTaskActive, resolveImageSourceFromGeneration, resolveVideoSourceFromGeneration } from '../utils'
import { uploadObject, generateUniqueKey, getSignedUrl } from '@/lib/storage'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { prisma } from '@/lib/prisma'
import { addTaskJob } from '@/lib/task/queues'
import { downloadMediaValueToBuffer, resolveCanonicalStorageKey } from '@/lib/media/download'
import { warpFrameRaft } from '@/lib/optical-flow/client'
import { reportTaskProgress } from '../shared'

const execAsync = util.promisify(exec)

async function chainNextFrameTask(params: {
  job: Job<TaskJobData>
  processedFrameKey: string
  nextFrameTaskId?: string
  logger: ReturnType<typeof createScopedLogger>
}) {
  const { job, processedFrameKey, nextFrameTaskId, logger } = params

  if (!nextFrameTaskId) return

  logger.info({ message: `Enqueuing next frame task: ${nextFrameTaskId}` })
    const nextTask = await prisma.task.findUnique({ where: { id: nextFrameTaskId } })
    if (nextTask) {
      await prisma.task.update({
        where: { id: nextFrameTaskId },
        data: {
          payload: {
            ...(nextTask.payload as object),
            prevProcessedFrameKey: processedFrameKey,
          },
        },
      })

      const nextJobData: TaskJobData = {
        taskId: nextTask.id,
        type: nextTask.type as TaskJobData['type'],
        locale: job.data.locale || 'en',
        projectId: nextTask.projectId,
        targetType: nextTask.targetType,
        targetId: nextTask.targetId,
        payload: {
          ...(nextTask.payload as object),
          prevProcessedFrameKey: processedFrameKey,
        } as Record<string, unknown>,
        userId: nextTask.userId,
      }
      await addTaskJob(nextJobData)
    }
}

/**
 * Chuẩn hóa kết quả generation thành storage key nhỏ gọn.
 * Kết quả có thể là data: base64 (nhiều MB), URL ngoài, hoặc storage key sẵn.
 * Tuyệt đối không được trả base64 ra ngoài: nó sẽ bị ghi vào DB result,
 * payload của frame kế tiếp, Redis job và log → nghẽn Redis, mất lock BullMQ, sập app.
 */
async function persistProcessedFrame(
  source: string,
  projectId: string,
): Promise<string> {
  if (source.startsWith('data:')) {
    const base64Start = source.indexOf(';base64,')
    if (base64Start === -1) {
      throw new Error('Kết quả data: URL không hợp lệ (thiếu base64)')
    }
    const buffer = Buffer.from(source.substring(base64Start + 8), 'base64')
    const key = generateUniqueKey(`projects/${projectId}/videos/frames_processed/`, 'jpg')
    await uploadObject(buffer, key, 3, 'image/jpeg')
    return key
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const buffer = await downloadMediaValueToBuffer(source)
    const key = generateUniqueKey(`projects/${projectId}/videos/frames_processed/`, 'jpg')
    await uploadObject(buffer, key, 3, 'image/jpeg')
    return key
  }

  // Đã là storage key (v2v path upload sẵn trước khi tới đây)
  return source.replace(/^\/+/, '')
}

export async function handleVideoFrameProcessTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-frame-process', taskId: job.data.taskId })
  const { userId, projectId } = job.data
  const {
    frameIndex,
    frameKey,
    prevFrameKey,
    prevProcessedFrameKey,
    prompt,
    referenceImageUrl,
    modelId,
    artStyle,
    processingMode,
    temporalMode,
    consistencySeed,
    totalFrames,
    nextFrameTaskId,
    mergeTaskId,
  } = job.data.payload as {
    frameIndex: number
    frameKey: string
    prevFrameKey?: string
    prevProcessedFrameKey?: string
    prompt: string
    referenceImageUrl?: string
    modelId: string
    artStyle?: string
    processingMode: 'img2img' | 'v2v'
    temporalMode: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
    consistencySeed?: number
    totalFrames: number
    motionVectorData?: string
    nextFrameTaskId?: string
    mergeTaskId?: string
  }

  if (!frameKey || !modelId) {
    throw new Error('Thiếu tham số bắt buộc cho frame process: frameKey hoặc modelId')
  }

  const passthrough = (job.data.payload as { passthrough?: boolean }).passthrough === true
  if (passthrough) {
    await reportTaskProgress(job, 100, {
      stage: 'completed',
      message: `[Frame #${frameIndex + 1}] Skipped — no target character in frame. Using original.`,
    })
    const key = (await resolveCanonicalStorageKey(frameKey)) || frameKey.replace(/^\/+/, '')
    await chainNextFrameTask({
      job,
      processedFrameKey: key,
      nextFrameTaskId,
      logger,
    })
    return {
      frameIndex,
      processedFrameKey: key,
      processedImageUrl: key,
      passthrough: true,
    }
  }

  await reportTaskProgress(job, 10, { stage: 'init', message: `Initializing processing for frame #${frameIndex + 1}/${totalFrames}...` })

  try {
    logger.info({ message: `1. Processing frame ${frameIndex + 1}/${totalFrames}` })
    
    const frameStorageKey = await resolveCanonicalStorageKey(frameKey)
    const frameUrl = frameStorageKey
      ? getSignedUrl(frameStorageKey, 3600)
      : frameKey

    let finalPrompt = prompt || 'Enhance this image'
    if (artStyle && artStyle.trim() !== '') {
      finalPrompt = `${finalPrompt}, ${artStyle} style`
    }

    const referenceImages: string[] = []
    
    // 1. Original frame as main reference (for img2img)
    referenceImages.push(frameUrl)

    // 2. User provided reference image (for style/character)
    if (referenceImageUrl) {
      const referenceKey = await resolveCanonicalStorageKey(referenceImageUrl)
      referenceImages.push(referenceKey ? getSignedUrl(referenceKey, 3600) : referenceImageUrl)
    }

    // 3. Temporal Consistency logic
    let prevProcessedUrl: string | undefined = undefined
    if (temporalMode === 'motion_compensated' && prevProcessedFrameKey && prevFrameKey) {
      logger.info({ message: 'Applying RAFT Motion Compensation' })
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-warp-'))
      const prevOrigPath = path.join(tempDir, 'prev_orig.jpg')
      const currOrigPath = path.join(tempDir, 'curr_orig.jpg')
      const prevProcPath = path.join(tempDir, 'prev_proc.jpg')
      
      const downloadKey = async (k: string, p: string) => {
        const buf = await downloadMediaValueToBuffer(k)
        fs.writeFileSync(p, buf)
      }

      await downloadKey(prevFrameKey, prevOrigPath)
      await downloadKey(frameKey, currOrigPath)
      await downloadKey(prevProcessedFrameKey, prevProcPath)

      const warpedKey = await warpFrameRaft(prevOrigPath, currOrigPath, prevProcPath, projectId)
      const mediaRef = await ensureMediaObjectFromStorageKey(warpedKey, { mimeType: 'image/jpeg' })
      referenceImages.push(mediaRef.url)
      finalPrompt = `${finalPrompt}. CRITICAL: Maintain exact visual consistency with the provided motion-aligned reference image.`
    } else if (temporalMode === 'prev_frame_ref' && prevProcessedFrameKey) {
      const prevKey = await resolveCanonicalStorageKey(prevProcessedFrameKey)
      const url = prevKey ? getSignedUrl(prevKey, 3600) : prevProcessedFrameKey
      prevProcessedUrl = url
      referenceImages.push(prevProcessedUrl)
      finalPrompt = `${finalPrompt}. CRITICAL: Maintain exact visual consistency with the provided reference images. Ensure character appearance, lighting, and color palette match perfectly.`
    }

    await reportTaskProgress(job, 20, { stage: 'prepare_refs', message: `[Frame #${frameIndex + 1}] Prepared reference images and RAFT optical flow motion compensation.` })
    await assertTaskActive(job, 'after_setup')

    let processedImageUrl = ''

    if (processingMode === 'img2img' || !processingMode) {
      logger.info({ message: '2. Generating processed frame (img2img)' })
      
      const seed = temporalMode === 'seed_consistency' ? (consistencySeed || 42) : undefined

      processedImageUrl = await resolveImageSourceFromGeneration(job, {
        userId,
        modelId,
        prompt: finalPrompt,
        options: {
          referenceImages,
          seed,
        }
      })
    } else if (processingMode === 'v2v') {
      logger.info({ message: '2. Generating processed frame (v2v)' })
      const videoRes = await resolveVideoSourceFromGeneration(job, {
        userId,
        modelId,
        imageUrl: frameUrl,
        options: {
          prompt: finalPrompt,
          generateAudio: false,
        }
      })

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2v-extract-'))
      const tempVideoPath = path.join(tempDir, 'video.mp4')
      const tempImgPath = path.join(tempDir, 'frame.jpg')

      const vBuf = await downloadMediaValueToBuffer(
        videoRes.url,
        videoRes.downloadHeaders,
      )
      fs.writeFileSync(tempVideoPath, vBuf)

      await execAsync(`ffmpeg -y -i "${tempVideoPath}" -vframes 1 "${tempImgPath}"`)

      const frameBuf = fs.readFileSync(tempImgPath)
      const finalKey = generateUniqueKey(`projects/${projectId}/videos/frames_processed/`, 'jpg')
      await uploadObject(frameBuf, finalKey, 3, 'image/jpeg')
      processedImageUrl = finalKey
    }
    
    await reportTaskProgress(job, 80, { stage: 'generating', message: `[Frame #${frameIndex + 1}] AI image generation completed via ${modelId}.` })
    await assertTaskActive(job, 'after_generation')

    logger.info({ message: '3. Uploading processed frame' })
    const finalKey = await persistProcessedFrame(processedImageUrl, projectId)

    await reportTaskProgress(job, 90, { stage: 'uploading', message: `[Frame #${frameIndex + 1}] Uploading processed frame to cloud storage...` })

    // Sequential chaining: if we have a next frame to process, enqueue it
    if (nextFrameTaskId) {
      await chainNextFrameTask({
        job,
        processedFrameKey: finalKey,
        nextFrameTaskId,
        logger,
      })
    }

    await reportTaskProgress(job, 100, { stage: 'completed', message: `[Frame #${frameIndex + 1}] Processed successfully!` })

    return {
      frameIndex,
      processedFrameKey: finalKey,
      processedImageUrl: finalKey,
    }

  } catch (error) {
    logger.error({ message: 'Error processing frame', error })
    throw error
  }
}
