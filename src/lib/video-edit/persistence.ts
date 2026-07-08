import { prisma } from '@/lib/prisma'
import { resolveMediaRef } from '@/lib/media/service'

export type VideoEditEngine = 'fbf' | 'chunk'

export type VideoEditRenderRecord = {
  id: string
  projectId: string
  engine: VideoEditEngine
  videoUrl: string
  meta: Record<string, unknown> | null
  createdAt: string
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export async function appendVideoEditRender(params: {
  projectId: string
  engine: VideoEditEngine
  mediaId: string
  meta?: Record<string, unknown>
}) {
  return prisma.videoEditRender.create({
    data: {
      projectId: params.projectId,
      engine: params.engine,
      videoMediaId: params.mediaId,
      meta: params.meta ? JSON.stringify(params.meta) : null,
    },
  })
}

export async function listVideoEditRenders(
  projectId: string,
  engine?: VideoEditEngine,
): Promise<VideoEditRenderRecord[]> {
  const rows = await prisma.videoEditRender.findMany({
    where: {
      projectId,
      ...(engine ? { engine } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: { videoMedia: true },
  })

  const results: VideoEditRenderRecord[] = []
  for (const row of rows) {
    const media = await resolveMediaRef(row.videoMediaId, row.videoMedia?.storageKey)
    if (!media?.url) continue
    results.push({
      id: row.id,
      projectId: row.projectId,
      engine: row.engine as VideoEditEngine,
      videoUrl: media.url,
      meta: parseMeta(row.meta),
      createdAt: row.createdAt.toISOString(),
    })
  }
  return results
}

export async function deleteVideoEditRender(projectId: string, renderId: string) {
  const row = await prisma.videoEditRender.findFirst({
    where: { id: renderId, projectId },
  })
  if (!row) return false
  await prisma.videoEditRender.delete({ where: { id: renderId } })
  return true
}

export async function saveVideoEditSession(
  projectId: string,
  engine: VideoEditEngine,
  session: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    ...session,
    updatedAt: new Date().toISOString(),
  })
  if (engine === 'fbf') {
    await prisma.novelPromotionProject.update({
      where: { projectId },
      data: { videoEditFbfSession: payload },
    })
  } else {
    await prisma.novelPromotionProject.update({
      where: { projectId },
      data: { videoEditChunkSession: payload },
    })
  }
}

export async function loadVideoEditSession(
  projectId: string,
  engine: VideoEditEngine,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.novelPromotionProject.findUnique({
    where: { projectId },
    select: {
      videoEditFbfSession: true,
      videoEditChunkSession: true,
    },
  })
  if (!row) return null
  const raw = engine === 'fbf' ? row.videoEditFbfSession : row.videoEditChunkSession
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export async function clearVideoEditSession(projectId: string, engine: VideoEditEngine) {
  if (engine === 'fbf') {
    await prisma.novelPromotionProject.updateMany({
      where: { projectId },
      data: { videoEditFbfSession: null },
    })
  } else {
    await prisma.novelPromotionProject.updateMany({
      where: { projectId },
      data: { videoEditChunkSession: null },
    })
  }
}
