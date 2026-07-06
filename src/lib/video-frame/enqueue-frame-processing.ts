import { prisma } from '@/lib/prisma'
import { addTaskJob } from '@/lib/task/queues'
import { TASK_TYPE, TASK_STATUS, type TaskJobData } from '@/lib/task/types'

export interface EnqueueFrameProcessingParams {
  userId: string
  projectId: string
  targetType: string
  targetId: string
  locale: string
  frameKeys: string[]
  audioUrl?: string
  targetFps: number
  originalDurationSec: number
  processingMode: 'img2img' | 'v2v'
  prompt?: string
  referenceImageUrl?: string
  modelId: string
  artStyle?: string
  temporalMode: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
  consistencySeed?: number
  motionDataKey?: string
  classifications?: Array<{ index: number; hasCharacter: boolean }>
  filterCharacterFrames?: boolean
}

export interface EnqueueFrameProcessingResult {
  frameTaskIds: string[]
  mergeTaskId: string
  chunkTasks: Array<{ taskId: string; index: number }>
}

export async function enqueueFrameProcessingTasks(
  params: EnqueueFrameProcessingParams,
): Promise<EnqueueFrameProcessingResult> {
  const {
    userId,
    projectId,
    targetType,
    targetId,
    locale,
    frameKeys,
    audioUrl,
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
    classifications,
    filterCharacterFrames,
  } = params

  const totalFrames = frameKeys.length
  if (totalFrames === 0) {
    throw new Error('frameKeys is empty')
  }

  const frameTaskIds: string[] = []

  const frameTasks = await Promise.all(
    frameKeys.map((frameKey, i) => {
      const classification = classifications?.find((item) => item.index === i)
      const passthrough = filterCharacterFrames === true && classification?.hasCharacter === false
      return prisma.task.create({
        data: {
          userId,
          projectId,
          type: TASK_TYPE.VIDEO_FRAME_PROCESS,
          status: TASK_STATUS.QUEUED,
          targetType,
          targetId,
          payload: {
            locale,
            meta: { locale },
            frameIndex: i,
            frameKey,
            prevFrameKey: i > 0 ? frameKeys[i - 1] : undefined,
            prompt,
            referenceImageUrl,
            modelId,
            artStyle,
            processingMode,
            temporalMode,
            consistencySeed,
            totalFrames,
            motionVectorData: motionDataKey,
            passthrough,
          },
        },
      })
    }),
  )
  frameTaskIds.push(...frameTasks.map((task) => task.id))

  const mergeTaskRecord = await prisma.task.create({
    data: {
      userId,
      projectId,
      type: TASK_TYPE.VIDEO_FRAME_MERGE,
      status: TASK_STATUS.QUEUED,
      targetType,
      targetId,
      payload: {
        locale,
        meta: { locale },
        audioUrl,
        targetFps,
        originalDurationSec,
        totalFrames,
        dependsOn: frameTaskIds.join(','),
      },
    },
  })

  const mergeTaskId = mergeTaskRecord.id
  const isSequential = temporalMode === 'prev_frame_ref' || temporalMode === 'motion_compensated'

  for (let i = 0; i < totalFrames; i++) {
    const nextTaskId = isSequential && i < totalFrames - 1 ? frameTaskIds[i + 1] : undefined
    await prisma.task.update({
      where: { id: frameTaskIds[i] },
      data: {
        payload: {
          ...(frameTasks[i].payload as object),
          nextFrameTaskId: nextTaskId,
          mergeTaskId,
        },
      },
    })
  }

  if (isSequential) {
    await addTaskJob(buildTaskJobData(frameTasks[0], locale))
  } else {
    await Promise.all(
      frameTasks.map((task) => addTaskJob(buildTaskJobData(task, locale))),
    )
  }

  return {
    frameTaskIds,
    mergeTaskId,
    chunkTasks: frameTaskIds.map((taskId, index) => ({ taskId, index })),
  }
}

function buildTaskJobData(
  task: {
    id: string
    type: string
    projectId: string
    targetType: string
    targetId: string
    payload: unknown
    userId: string
  },
  locale: string,
): TaskJobData {
  return {
    taskId: task.id,
    type: task.type as TaskJobData['type'],
    locale: locale as TaskJobData['locale'],
    projectId: task.projectId,
    targetType: task.targetType,
    targetId: task.targetId,
    payload: task.payload as Record<string, unknown>,
    userId: task.userId,
  }
}

export async function enqueueFrameMergeTask(params: {
  userId: string
  projectId: string
  targetType: string
  targetId: string
  locale: string
  mergeTaskId: string
}): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: params.mergeTaskId } })
  if (!task) {
    throw new Error('Merge task not found')
  }
  if (task.userId !== params.userId || task.projectId !== params.projectId) {
    throw new Error('Merge task access denied')
  }
  if (task.type !== TASK_TYPE.VIDEO_FRAME_MERGE) {
    throw new Error('Invalid merge task type')
  }
  if (task.status !== TASK_STATUS.QUEUED) {
    return
  }

  const updated = await prisma.task.updateMany({
    where: { id: task.id, status: TASK_STATUS.QUEUED },
    data: { status: TASK_STATUS.PROCESSING },
  })
  if (updated.count === 0) return

  try {
    await addTaskJob(buildTaskJobData(task, params.locale))
  } catch (error) {
    await prisma.task.updateMany({
      where: { id: task.id, status: TASK_STATUS.PROCESSING },
      data: { status: TASK_STATUS.QUEUED },
    })
    throw error
  }
}

export async function enqueueSingleFrameRetry(params: {
  userId: string
  projectId: string
  targetType: string
  targetId: string
  locale: string
  frameIndex: number
  frameKey: string
  prevFrameKey?: string
  prevProcessedFrameKey?: string
  totalFrames: number
  processingMode: 'img2img' | 'v2v'
  prompt?: string
  referenceImageUrl?: string
  modelId: string
  artStyle?: string
  temporalMode: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
  consistencySeed?: number
  passthrough?: boolean
}): Promise<string> {
  const taskRecord = await prisma.task.create({
    data: {
      userId: params.userId,
      projectId: params.projectId,
      type: TASK_TYPE.VIDEO_FRAME_PROCESS,
      status: TASK_STATUS.QUEUED,
      targetType: params.targetType,
      targetId: `${params.targetId}_frame_${params.frameIndex}_retry_${Date.now()}`,
      payload: {
        locale: params.locale,
        meta: { locale: params.locale },
        frameIndex: params.frameIndex,
        frameKey: params.frameKey,
        prevFrameKey: params.prevFrameKey,
        prevProcessedFrameKey: params.prevProcessedFrameKey,
        prompt: params.prompt,
        referenceImageUrl: params.referenceImageUrl,
        modelId: params.modelId,
        artStyle: params.artStyle,
        processingMode: params.processingMode,
        temporalMode: params.temporalMode,
        consistencySeed: params.consistencySeed,
        totalFrames: params.totalFrames,
        passthrough: params.passthrough === true,
      },
    },
  })

  await addTaskJob(buildTaskJobData(taskRecord, params.locale))
  return taskRecord.id
}

/** Tạo merge task mới sau khi user retry từng frame (taskId có thể đã thay đổi). */
export async function enqueueRemergeFrames(params: {
  userId: string
  projectId: string
  targetType: string
  targetId: string
  locale: string
  frameTaskIds: string[]
  audioUrl?: string
  targetFps: number
  originalDurationSec: number
  totalFrames: number
}): Promise<string> {
  if (params.frameTaskIds.length === 0) {
    throw new Error('frameTaskIds is empty')
  }

  const mergeTaskRecord = await prisma.task.create({
    data: {
      userId: params.userId,
      projectId: params.projectId,
      type: TASK_TYPE.VIDEO_FRAME_MERGE,
      status: TASK_STATUS.QUEUED,
      targetType: params.targetType,
      targetId: params.targetId,
      payload: {
        locale: params.locale,
        meta: { locale: params.locale },
        audioUrl: params.audioUrl,
        targetFps: params.targetFps,
        originalDurationSec: params.originalDurationSec,
        totalFrames: params.totalFrames,
        dependsOn: params.frameTaskIds.join(','),
      },
    },
  })

  await enqueueFrameMergeTask({
    userId: params.userId,
    projectId: params.projectId,
    targetType: params.targetType,
    targetId: params.targetId,
    locale: params.locale,
    mergeTaskId: mergeTaskRecord.id,
  })

  return mergeTaskRecord.id
}
