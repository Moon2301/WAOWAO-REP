'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import type { NovelPromotionStoryboard } from '@/types/project'
import { extractErrorMessage } from '@/lib/errors/extract'

interface MergeVideosMutationLike {
  mutateAsync: (payload: { episodeId: string }) => Promise<Blob>
}

interface UsePanelVideoMergeParams {
  localStoryboards: NovelPromotionStoryboard[]
  mergeVideosMutation: MergeVideosMutationLike
  setIsMergingVideos: React.Dispatch<React.SetStateAction<boolean>>
}

export function usePanelVideoMerge({
  localStoryboards,
  mergeVideosMutation,
  setIsMergingVideos,
}: UsePanelVideoMergeParams) {
  const t = useTranslations('storyboard')

  const mergeAllVideos = useCallback(async () => {
    const firstEpisodeId = localStoryboards[0]?.episodeId
    if (!firstEpisodeId) {
      alert(t('messages.episodeNotFound'))
      return
    }

    setIsMergingVideos(true)
    try {
      const blob = await mergeVideosMutation.mutateAsync({ episodeId: firstEpisodeId })
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `merged_episode_${firstEpisodeId}.mp4`
      document.body.appendChild(anchor)
      anchor.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(anchor)
    } catch (error: unknown) {
      alert(
        t('messages.mergeVideosFailed', {
          error: extractErrorMessage(error, t('common.unknownError')),
        }),
      )
    } finally {
      setIsMergingVideos(false)
    }
  }, [mergeVideosMutation, localStoryboards, setIsMergingVideos, t])

  return {
    mergeAllVideos,
  }
}
