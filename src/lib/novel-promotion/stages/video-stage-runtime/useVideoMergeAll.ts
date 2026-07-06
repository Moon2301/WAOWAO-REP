'use client'

import { useCallback, useState } from 'react'
import { logError as _ulogError, logInfo as _ulogInfo } from '@/lib/logging/core'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import { getErrorMessage } from './utils'

interface MutationLike<TInput = unknown, TOutput = unknown> {
  mutateAsync: (input: TInput) => Promise<TOutput>
}

interface UseVideoMergeAllParams {
  episodeId: string
  t: (key: string) => string
  allPanels: VideoPanel[]
  panelVideoPreference: Map<string, boolean>
  mergeVideosMutation: MutationLike<{
    episodeId: string
    panelPreferences: Record<string, boolean>
  }, Blob>
}

export function useVideoMergeAll({
  episodeId,
  t,
  allPanels,
  panelVideoPreference,
  mergeVideosMutation,
}: UseVideoMergeAllParams) {
  const [isMerging, setIsMerging] = useState(false)

  const handleMergeAllVideos = useCallback(async () => {
    const videosWithUrl = allPanels.filter((panel) => panel.videoUrl).length
    if (videosWithUrl === 0) return
    
    setIsMerging(true)
    try {
      const panelPreferences: Record<string, boolean> = {}
      allPanels.forEach((panel) => {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        panelPreferences[panelKey] = panelVideoPreference.get(panelKey) ?? true
      })

      _ulogInfo('[合并视频] 正在发送合并请求...')
      const blob = await mergeVideosMutation.mutateAsync({
        episodeId,
        panelPreferences,
      })

      _ulogInfo('[合并视频] 请求成功，正在下载...')
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `merged_episode_${episodeId}.mp4`
      document.body.appendChild(anchor)
      anchor.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(anchor)
      _ulogInfo('[合并视频] 完成!')
    } catch (error: unknown) {
      _ulogError('[合并视频] 错误:', error)
      alert(`${t('stage.mergeFailed') || 'Gộp video thất bại'}: ${getErrorMessage(error) || 'Lỗi không xác định'}`)
    } finally {
      setIsMerging(false)
    }
  }, [
    allPanels,
    episodeId,
    mergeVideosMutation,
    panelVideoPreference,
    t,
  ])

  return {
    isMerging,
    handleMergeAllVideos,
  }
}
