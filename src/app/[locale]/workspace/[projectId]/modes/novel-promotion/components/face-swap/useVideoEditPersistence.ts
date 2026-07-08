'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import type { VideoEditEngine, VideoEditRenderRecord } from '@/lib/video-edit/persistence'

export const videoEditKeys = {
  renders: (projectId: string, engine?: VideoEditEngine) =>
    ['video-edit-renders', projectId, engine ?? 'all'] as const,
}

export function useVideoEditRenders(projectId: string, engine: VideoEditEngine) {
  return useQuery({
    queryKey: videoEditKeys.renders(projectId, engine),
    queryFn: async () => {
      const res = await apiFetch(
        `/api/novel-promotion/${projectId}/video-edit?engine=${engine}&includeRenders=true`,
      )
      if (!res.ok) throw new Error('Failed to load render history')
      const data = await res.json()
      return (data.renders ?? []) as VideoEditRenderRecord[]
    },
    enabled: Boolean(projectId),
    staleTime: 10_000,
  })
}

export function useVideoEditRenderActions(projectId: string, engine: VideoEditEngine) {
  const queryClient = useQueryClient()

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: videoEditKeys.renders(projectId, engine) })
    void queryClient.invalidateQueries({ queryKey: videoEditKeys.renders(projectId) })
  }, [queryClient, projectId, engine])

  const deleteRender = useCallback(async (renderId: string) => {
    const res = await apiFetch(
      `/api/novel-promotion/${projectId}/video-edit?renderId=${encodeURIComponent(renderId)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error('Không thể xóa bản render')
    invalidate()
  }, [projectId, invalidate])

  return { deleteRender, invalidate }
}

export async function saveVideoEditSessionRemote(
  projectId: string,
  engine: VideoEditEngine,
  session: Record<string, unknown>,
) {
  await apiFetch(`/api/novel-promotion/${projectId}/video-edit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, session }),
  })
}

export async function loadVideoEditSessionRemote(
  projectId: string,
  engine: VideoEditEngine,
): Promise<Record<string, unknown> | null> {
  const res = await apiFetch(
    `/api/novel-promotion/${projectId}/video-edit?engine=${engine}&includeRenders=false`,
  )
  if (!res.ok) return null
  const data = await res.json()
  return data.session ?? null
}
