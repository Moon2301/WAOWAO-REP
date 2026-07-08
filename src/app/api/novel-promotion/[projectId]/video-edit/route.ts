import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  deleteVideoEditRender,
  listVideoEditRenders,
  loadVideoEditSession,
  saveVideoEditSession,
  type VideoEditEngine,
} from '@/lib/video-edit/persistence'

const engineSchema = z.enum(['fbf', 'chunk'])

const putBodySchema = z.object({
  engine: engineSchema,
  session: z.record(z.unknown()),
})

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const engineParam = request.nextUrl.searchParams.get('engine')
  const engine = engineParam ? engineSchema.safeParse(engineParam) : null
  if (engineParam && !engine?.success) {
    throw new ApiError('INVALID_PARAMS', { message: 'Invalid engine' })
  }

  const includeRenders = request.nextUrl.searchParams.get('includeRenders') !== 'false'

  const session = engine?.success
    ? await loadVideoEditSession(projectId, engine.data)
    : null

  const renders = includeRenders
    ? await listVideoEditRenders(projectId, engine?.success ? engine.data : undefined)
    : []

  return NextResponse.json({
    session,
    renders,
  })
})

export const PUT = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const body = await request.json()
  const parsed = putBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError('INVALID_PARAMS', { message: 'Invalid session payload' })
  }

  const { engine, session } = parsed.data
  await saveVideoEditSession(projectId, engine as VideoEditEngine, session)

  return NextResponse.json({ success: true })
})

export const DELETE = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const renderId = request.nextUrl.searchParams.get('renderId')
  if (!renderId) {
    throw new ApiError('INVALID_PARAMS', { message: 'renderId is required' })
  }

  const deleted = await deleteVideoEditRender(projectId, renderId)
  if (!deleted) {
    throw new ApiError('NOT_FOUND', { message: 'Render not found' })
  }

  return NextResponse.json({ success: true })
})
