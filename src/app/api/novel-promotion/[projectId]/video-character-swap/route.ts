import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { prisma } from '@/lib/prisma'
import { resolveCanonicalStorageKey } from '@/lib/media/download'
import { clearChunkResultVideo } from '@/lib/video-frame/fbf-result-persistence'
import { snapVideoDurationForModel } from '@/lib/model-capabilities/video-duration-snap'
import { TASK_STATUS } from '@/lib/task/types'

function snapChunkDuration(modelId: string, duration: unknown, fallback = 5): number {
  const raw = typeof duration === 'number' && Number.isFinite(duration) ? duration : fallback
  return snapVideoDurationForModel(modelId, raw)
}

async function normalizeTaskMediaUrl(mediaUrl: string, fieldName: string): Promise<string> {
  const key = await resolveCanonicalStorageKey(mediaUrl)
  if (!key) {
    throw new ApiError('INVALID_PARAMS', { message: `Invalid or unresolved ${fieldName}: ${mediaUrl.substring(0, 120)}` })
  }
  return key
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params
  
  if (!projectId) {
    throw new ApiError('INVALID_PARAMS', { message: 'projectId is required' })
  }
  
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const { session } = auth

  const body = await request.json()
  const { action } = body

  const locale = resolveRequiredTaskLocale(request)

  // ─── Action: generate_chunks ────────────────────────────────────────
  // User reviewed the split, now submit chunk tasks for AI generation
  if (action === 'generate_chunks') {
    const {
      chunks,
      targetImageUrl,
      modelId,
      prompt,
      characterHint,
      resolution,
      artStyle,
      baseChunkDuration,
      originalAudioUrl,
      originalDurationSec,
      classifications,
      filterCharacterChunks,
    } = body
    
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      throw new ApiError('INVALID_PARAMS', { message: 'chunks array is required' })
    }
    if (!targetImageUrl || !modelId) {
      throw new ApiError('INVALID_PARAMS', { message: 'targetImageUrl and modelId are required' })
    }

    await clearChunkResultVideo(projectId)

    const normalizedTargetImageUrl = await normalizeTaskMediaUrl(targetImageUrl, 'targetImageUrl')

    const parentTaskId = `swap_gen_${projectId}_${Date.now()}`
    const chunkTasks: { taskId: string, index: number }[] = []

    const snappedDuration = snapChunkDuration(modelId, baseChunkDuration, 5)

    for (const chunk of chunks) {
      const classification = Array.isArray(classifications)
        ? classifications.find((item: { index: number }) => item.index === chunk.index)
        : undefined
      const passthrough = filterCharacterChunks === true && classification?.hasCharacter === false

      const result = await submitTask({
        userId: session.user.id,
        locale,
        requestId: getRequestId(request),
        projectId,
        type: TASK_TYPE.VIDEO_CHARACTER_SWAP_CHUNK,
        targetType: 'VideoCharacterSwapChunk',
        targetId: `${parentTaskId}_${chunk.index}`,
        payload: withTaskUiPayload({
          parentTaskId,
          chunkIndex: chunk.index,
          chunkOriginalUrl: chunk.originalUrl,
          targetImageUrl: normalizedTargetImageUrl,
          modelId,
          prompt,
          characterHint,
          duration: snappedDuration,
          baseChunkDuration: snappedDuration,
          generationMode: 'normal',
          resolution: resolution || '1080p',
          aspectRatio: '16:9',
          artStyle,
          passthrough,
        }, {}),
      })
      chunkTasks.push({ taskId: result.taskId, index: chunk.index })
    }

    return NextResponse.json({
      success: true,
      parentTaskId,
      chunkTasks,
      originalAudioUrl,
      originalDurationSec,
    })
  }

  // ─── Action: chunk_retry ────────────────────────────────────────────
  if (action === 'chunk_retry') {
    const { chunkOriginalUrl, targetImageUrl, modelId, prompt, characterHint, chunkIndex, parentTaskId, duration, baseChunkDuration, resolution, artStyle } = body

    if (!chunkOriginalUrl || !targetImageUrl || !modelId || typeof chunkIndex !== 'number' || !parentTaskId) {
      throw new ApiError('INVALID_PARAMS', { message: 'Missing parameters for chunk_retry' })
    }
    const normalizedTargetImageUrl = await normalizeTaskMediaUrl(targetImageUrl, 'targetImageUrl')
    const snappedDuration = snapChunkDuration(
      modelId,
      duration ?? baseChunkDuration,
      5,
    )
    const result = await submitTask({
      userId: session.user.id,
      locale,
      requestId: getRequestId(request),
      projectId,
      type: TASK_TYPE.VIDEO_CHARACTER_SWAP_CHUNK,
      targetType: 'VideoCharacterSwapChunk',
      targetId: `${parentTaskId}_${chunkIndex}_retry`,
      payload: withTaskUiPayload({
        parentTaskId,
        chunkIndex,
        chunkOriginalUrl,
        targetImageUrl: normalizedTargetImageUrl,
        modelId,
        prompt,
        characterHint,
        duration: snappedDuration,
        baseChunkDuration: snappedDuration,
        generationMode: 'normal',
        resolution: resolution || '1080p',
        aspectRatio: '16:9',
        artStyle,
      }, {}),
    })
    return NextResponse.json({ success: true, taskId: result.taskId, status: result.status })
  }

  // ─── Action: replace_chunk_result ─────────────────────────────────
  if (action === 'replace_chunk_result') {
    const { chunkIndex, resultKey, taskId } = body

    if (typeof chunkIndex !== 'number' || chunkIndex < 0 || !resultKey) {
      throw new ApiError('INVALID_PARAMS', { message: 'chunkIndex and resultKey are required' })
    }

    const normalizedKey = await normalizeTaskMediaUrl(resultKey, 'resultKey')

    if (taskId) {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, userId: true, projectId: true, result: true },
      })
      if (!task || task.userId !== session.user.id || task.projectId !== projectId) {
        throw new ApiError('FORBIDDEN', { message: 'Chunk task access denied' })
      }

      const prevResult = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
        ? task.result as Record<string, unknown>
        : {}

      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: TASK_STATUS.COMPLETED,
          progress: 100,
          errorCode: null,
          errorMessage: null,
          result: {
            ...prevResult,
            chunkIndex,
            videoUrl: normalizedKey,
            manualOverride: true,
          },
        },
      })
    }

    return NextResponse.json({ success: true, resultKey: normalizedKey })
  }

  // ─── Action: clear_chunk_result ─────────────────────────────────────
  if (action === 'clear_chunk_result') {
    await clearChunkResultVideo(projectId)
    return NextResponse.json({ success: true })
  }

  // ─── Action: merge ──────────────────────────────────────────────────
  if (action === 'merge') {
    const { chunkUrls, originalAudioUrl, originalDurationSec } = body

    if (!chunkUrls || !Array.isArray(chunkUrls) || chunkUrls.length === 0) {
      throw new ApiError('INVALID_PARAMS', { message: 'Missing chunkUrls for merge' })
    }
    const result = await submitTask({
      userId: session.user.id,
      locale,
      requestId: getRequestId(request),
      projectId,
      type: TASK_TYPE.VIDEO_CHARACTER_SWAP_MERGE,
      targetType: 'Project',
      targetId: projectId,
      payload: withTaskUiPayload({
        chunkUrls,
        originalAudioUrl,
        originalDurationSec,
      }, {}),
      billingInfo: { billable: false },
    })
    return NextResponse.json({ success: true, taskId: result.taskId, status: result.status })
  }

  // ─── Default action: split ──────────────────────────────────────────
  const { videoUrl, chunkDuration } = body

  if (!videoUrl) {
    throw new ApiError('INVALID_PARAMS', { message: `videoUrl is required. Received: ${JSON.stringify(body)}` })
  }

  const normalizedVideoUrl = await normalizeTaskMediaUrl(videoUrl, 'videoUrl')
  await clearChunkResultVideo(projectId)

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId: getRequestId(request),
    projectId,
    type: TASK_TYPE.VIDEO_CHARACTER_SWAP,
    targetType: 'Project',
    targetId: projectId,
    payload: withTaskUiPayload({
      videoUrl: normalizedVideoUrl,
      chunkDuration: chunkDuration || undefined,
    }, {}),
    dedupeKey: `video_character_swap:${projectId}:${normalizedVideoUrl}:${chunkDuration || 'auto'}`,
    billingInfo: { billable: false },
  })

  if (!result.success) {
    throw new ApiError('INTERNAL_ERROR', { message: 'Failed to submit task' })
  }

  return NextResponse.json({
    success: true,
    taskId: result.taskId,
    status: result.status,
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
    }
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
