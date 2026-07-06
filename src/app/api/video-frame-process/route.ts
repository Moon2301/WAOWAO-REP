import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { prisma } from '@/lib/prisma'
import { TASK_TYPE } from '@/lib/task/types'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { enqueueFrameProcessingTasks, enqueueFrameMergeTask, enqueueSingleFrameRetry, enqueueRemergeFrames } from '@/lib/video-frame/enqueue-frame-processing'
import { clearFbfResultVideo } from '@/lib/video-frame/fbf-result-persistence'
import { resolveCanonicalStorageKey } from '@/lib/media/download'

async function normalizeTaskVideoUrl(videoUrl: string): Promise<string> {
  const key = await resolveCanonicalStorageKey(videoUrl)
  if (!key) {
    throw new ApiError('INVALID_PARAMS', { message: `Invalid or unresolved videoUrl: ${videoUrl.substring(0, 120)}` })
  }
  return key
}

const extractSchema = z.object({
  action: z.literal('extract').optional(),
  projectId: z.string(),
  videoUrl: z.string().min(1),
  targetFps: z.number().min(1).max(30).optional().default(8),
})

const generateFramesSchema = z.object({
  action: z.literal('generate_frames'),
  projectId: z.string(),
  frameKeys: z.array(z.string().min(1)).min(1),
  targetFps: z.number().min(1).max(30),
  originalDurationSec: z.number().min(0),
  audioUrl: z.string().optional(),
  processingMode: z.enum(['img2img', 'v2v']),
  prompt: z.string().optional(),
  referenceImageUrl: z.string().optional(),
  characterHint: z.string().optional(),
  modelId: z.string(),
  artStyle: z.string().optional(),
  temporalMode: z.enum(['none', 'seed_consistency', 'prev_frame_ref', 'motion_compensated']).optional().default('prev_frame_ref'),
  consistencySeed: z.number().optional(),
  motionDataKey: z.string().optional(),
  filterCharacterFrames: z.boolean().optional().default(false),
  classifications: z.array(z.object({
    index: z.number().int().min(0),
    hasCharacter: z.boolean(),
    reason: z.string().optional(),
  })).optional(),
})

const classifyFramesSchema = z.object({
  action: z.literal('classify_frames'),
  projectId: z.string(),
  frameKeys: z.array(z.string().min(1)).min(1),
  characterHint: z.string().optional(),
  referenceImageUrl: z.string().optional(),
})

const mergeSchema = z.object({
  action: z.literal('merge'),
  projectId: z.string(),
  mergeTaskId: z.string().min(1),
})

const frameRetrySchema = z.object({
  action: z.literal('frame_retry'),
  projectId: z.string(),
  frameIndex: z.number().int().min(0),
  frameKey: z.string().min(1),
  prevFrameKey: z.string().optional(),
  prevProcessedFrameKey: z.string().optional(),
  totalFrames: z.number().int().min(1),
  processingMode: z.enum(['img2img', 'v2v']),
  prompt: z.string().optional(),
  referenceImageUrl: z.string().optional(),
  modelId: z.string(),
  artStyle: z.string().optional(),
  temporalMode: z.enum(['none', 'seed_consistency', 'prev_frame_ref', 'motion_compensated']).optional().default('prev_frame_ref'),
  consistencySeed: z.number().optional(),
  passthrough: z.boolean().optional(),
})

const remergeFramesSchema = z.object({
  action: z.literal('remerege_frames'),
  projectId: z.string(),
  frameTaskIds: z.array(z.string().min(1)).min(1),
  targetFps: z.number().min(1).max(30),
  originalDurationSec: z.number().min(0),
  audioUrl: z.string().optional(),
  totalFrames: z.number().int().min(1),
})

const clearFbfResultSchema = z.object({
  action: z.literal('clear_fbf_result'),
  projectId: z.string(),
})

const legacySchema = z.object({
  projectId: z.string(),
  videoUrl: z.string().min(1),
  targetFps: z.number().min(1).max(30).optional().default(8),
  processingMode: z.enum(['img2img', 'v2v']),
  prompt: z.string().optional(),
  referenceImageUrl: z.string().optional(),
  modelId: z.string(),
  artStyle: z.string().optional(),
  temporalMode: z.enum(['none', 'seed_consistency', 'prev_frame_ref', 'motion_compensated']).optional().default('none'),
  consistencySeed: z.number().optional(),
})

async function assertProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project || project.userId !== userId) {
    throw new ApiError('FORBIDDEN', { message: 'Project not found or access denied' })
  }
}

const FBF_MAX_FRAMES = 120

export const maxDuration = 120

export const POST = apiHandler(async (req: NextRequest) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const user = session.user

  const body = await req.json()
  const locale = resolveRequiredTaskLocale(req)

  if (body?.action === 'generate_frames') {
    const parsed = generateFramesSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid generate_frames request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)
    await clearFbfResultVideo(data.projectId)

    if (data.frameKeys.length > FBF_MAX_FRAMES) {
      throw new ApiError('INVALID_PARAMS', {
        message: `Too many frames (${data.frameKeys.length}). Max ${FBF_MAX_FRAMES}. Lower FPS or use a shorter video.`,
      })
    }

    const result = await enqueueFrameProcessingTasks({
      userId: user.id,
      projectId: data.projectId,
      targetType: 'VideoFrameProcess',
      targetId: data.projectId,
      locale,
      frameKeys: data.frameKeys,
      audioUrl: data.audioUrl,
      targetFps: data.targetFps,
      originalDurationSec: data.originalDurationSec,
      processingMode: data.processingMode,
      prompt: data.prompt,
      referenceImageUrl: data.referenceImageUrl,
      modelId: data.modelId,
      artStyle: data.artStyle,
      temporalMode: data.temporalMode,
      consistencySeed: data.consistencySeed,
      motionDataKey: data.motionDataKey,
      classifications: data.classifications,
      filterCharacterFrames: data.filterCharacterFrames,
    })

    return NextResponse.json({
      success: true,
      frameTaskIds: result.frameTaskIds,
      mergeTaskId: result.mergeTaskId,
      chunkTasks: result.chunkTasks,
    })
  }

  if (body?.action === 'classify_frames') {
    const parsed = classifyFramesSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid classify_frames request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)

    const result = await submitTask({
      userId: user.id,
      locale,
      requestId: getRequestId(req),
      projectId: data.projectId,
      type: TASK_TYPE.VIDEO_FRAME_CLASSIFY,
      targetType: 'VideoFrameProcess',
      targetId: data.projectId,
      payload: withTaskUiPayload({
        frameKeys: data.frameKeys,
        characterHint: data.characterHint,
        referenceImageUrl: data.referenceImageUrl,
      }, {}),
      billingInfo: { billable: false },
    })

    if (!result.success) {
      throw new ApiError('INTERNAL_ERROR', { message: 'Failed to submit classify task' })
    }

    return NextResponse.json({
      success: true,
      taskId: result.taskId,
    })
  }

  if (body?.action === 'frame_retry') {
    const parsed = frameRetrySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid frame_retry request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)

    const taskId = await enqueueSingleFrameRetry({
      userId: user.id,
      projectId: data.projectId,
      targetType: 'VideoFrameProcess',
      targetId: data.projectId,
      locale,
      frameIndex: data.frameIndex,
      frameKey: data.frameKey,
      prevFrameKey: data.prevFrameKey,
      prevProcessedFrameKey: data.prevProcessedFrameKey,
      totalFrames: data.totalFrames,
      processingMode: data.processingMode,
      prompt: data.prompt,
      referenceImageUrl: data.referenceImageUrl,
      modelId: data.modelId,
      artStyle: data.artStyle,
      temporalMode: data.temporalMode,
      consistencySeed: data.consistencySeed,
      passthrough: data.passthrough,
    })

    return NextResponse.json({ success: true, taskId })
  }

  if (body?.action === 'remerege_frames') {
    const parsed = remergeFramesSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid remerege_frames request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)

    const mergeTaskId = await enqueueRemergeFrames({
      userId: user.id,
      projectId: data.projectId,
      targetType: 'VideoFrameProcess',
      targetId: data.projectId,
      locale,
      frameTaskIds: data.frameTaskIds,
      audioUrl: data.audioUrl,
      targetFps: data.targetFps,
      originalDurationSec: data.originalDurationSec,
      totalFrames: data.totalFrames,
    })

    return NextResponse.json({ success: true, mergeTaskId })
  }

  if (body?.action === 'merge') {
    const parsed = mergeSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid merge request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)
    const mergeTask = await prisma.task.findUnique({
      where: { id: data.mergeTaskId },
      select: { id: true, userId: true, projectId: true, type: true },
    })
    if (!mergeTask) {
      throw new ApiError('NOT_FOUND', { message: 'Merge task not found' })
    }
    if (mergeTask.userId !== user.id || mergeTask.projectId !== data.projectId) {
      throw new ApiError('FORBIDDEN', { message: 'Merge task access denied' })
    }
    if (mergeTask.type !== TASK_TYPE.VIDEO_FRAME_MERGE) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid merge task type' })
    }

    await enqueueFrameMergeTask({
      userId: user.id,
      projectId: data.projectId,
      targetType: 'VideoFrameProcess',
      targetId: data.projectId,
      locale,
      mergeTaskId: data.mergeTaskId,
    })

    return NextResponse.json({
      success: true,
      taskId: data.mergeTaskId,
    })
  }

  if (body?.action === 'clear_fbf_result') {
    const parsed = clearFbfResultSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('INVALID_PARAMS', { message: 'Invalid clear_fbf_result request' })
    }

    const data = parsed.data
    await assertProjectAccess(data.projectId, user.id)
    await clearFbfResultVideo(data.projectId)

    return NextResponse.json({ success: true })
  }

  const isExtractOnly = body?.action === 'extract' || body?.extractOnly === true
  const extractParsed = extractSchema.safeParse(body)
  if (isExtractOnly && extractParsed.success) {
    const { projectId, videoUrl, targetFps } = extractParsed.data
    await assertProjectAccess(projectId, user.id)
    await clearFbfResultVideo(projectId)
    const normalizedVideoUrl = await normalizeTaskVideoUrl(videoUrl)

    const result = await submitTask({
      userId: user.id,
      locale,
      requestId: getRequestId(req),
      projectId,
      type: TASK_TYPE.VIDEO_FRAME_EXTRACT,
      targetType: 'VideoFrameProcess',
      targetId: projectId,
      payload: withTaskUiPayload({
        videoUrl: normalizedVideoUrl,
        targetFps,
        processingMode: 'img2img',
        extractOnly: true,
      }, {}),
      billingInfo: { billable: false },
    })

    if (!result.success) {
      throw new ApiError('INTERNAL_ERROR', { message: 'Failed to submit extract task' })
    }

    return NextResponse.json({
      taskId: result.taskId,
      message: 'Frame extraction started',
    })
  }

  const legacyParsed = legacySchema.safeParse(body)
  if (!legacyParsed.success) {
    throw new ApiError('INVALID_PARAMS', { message: 'Invalid request data' })
  }

  const {
    projectId,
    videoUrl,
    targetFps,
    processingMode,
    prompt,
    referenceImageUrl,
    modelId,
    artStyle,
    temporalMode,
    consistencySeed,
  } = legacyParsed.data

  await assertProjectAccess(projectId, user.id)
  const normalizedVideoUrl = await normalizeTaskVideoUrl(videoUrl)

  const result = await submitTask({
    userId: user.id,
    locale,
    requestId: getRequestId(req),
    projectId,
    type: TASK_TYPE.VIDEO_FRAME_EXTRACT,
    targetType: 'VideoFrameProcess',
    targetId: projectId,
    payload: withTaskUiPayload({
      videoUrl: normalizedVideoUrl,
      targetFps,
      processingMode,
      prompt,
      referenceImageUrl,
      modelId,
      artStyle,
      temporalMode,
      consistencySeed,
      extractOnly: false,
    }, {}),
    billingInfo: { billable: false },
  })

  if (!result.success) {
    throw new ApiError('INTERNAL_ERROR', { message: 'Failed to submit task' })
  }

  return NextResponse.json({
    taskId: result.taskId,
    message: 'Video frame processing started',
  })
})

export const GET = apiHandler(async (request: NextRequest) => {
  const taskId = request.nextUrl.searchParams.get('taskId')
  if (!taskId) throw new ApiError('INVALID_PARAMS', { message: 'taskId is required' })

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      status: true,
      progress: true,
      result: true,
      errorCode: true,
      errorMessage: true,
    },
  })

  if (!task) throw new ApiError('NOT_FOUND', { message: 'Task not found' })

  return NextResponse.json({
    taskId: task.id,
    status: task.status,
    progress: task.progress,
    result: task.result,
    error: task.errorMessage || task.errorCode,
  })
})
