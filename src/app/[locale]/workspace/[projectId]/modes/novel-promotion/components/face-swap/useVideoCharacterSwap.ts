import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'

function normalizeUploadedMediaRef(value: string): string {
  if (!value) return value
  if (/(?:^|\/)api\/storage\/sign(?:\?|$)/.test(value)) {
    try {
      const normalized = value.startsWith('/') ? value : `/${value}`
      const parsed = new URL(normalized, 'http://localhost')
      const key = parsed.searchParams.get('key')
      if (key) return decodeURIComponent(key).replace(/^\/+/, '')
    } catch {
      // ignore parse errors
    }
  }
  return value.replace(/^\/+/, '')
}

export type SplitChunkInfo = {
  originalUrl: string
  index: number
  duration: number
}

export type FaceSwapChunk = SplitChunkInfo & {
  taskId: string
  status?: string
  progress?: number
  resultVideoUrl?: string
  error?: string
}

export function useVideoCharacterSwap(
  defaultModelId?: string,
  options?: {
    persistedResultVideoUrl?: string | null
    onResultPersisted?: () => void
  },
) {
  const params = useParams()
  const projectId = params?.projectId as string
  const persistedResultVideoUrl = options?.persistedResultVideoUrl
  const onResultPersisted = options?.onResultPersisted

  // ─── User Inputs ────────────────────────────────────────────────────
  const [sourceVideoFile, setSourceVideoFile] = useState<File | null>(null)
  const [targetImageFile, setTargetImageFile] = useState<File | null>(null)
  
  const [modelId, setModelId] = useState<string>(defaultModelId || 'fal::fal-wan25')
  const [prompt, setPrompt] = useState<string>('')
  const [characterHint, setCharacterHint] = useState<string>('')
  const [resolution, setResolution] = useState<string>('1080p')
  const [artStyle, setArtStyle] = useState<string>('')
  const [chunkDuration, setChunkDuration] = useState<number>(5)

  useEffect(() => {
    if (defaultModelId) {
      setModelId(defaultModelId)
    }
  }, [defaultModelId])


  // ─── Phase States ───────────────────────────────────────────────────
  const [isUploading, setIsUploading] = useState(false)
  const [isSplitting, setIsSplitting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  
  // ─── Split Results (Phase 1) ────────────────────────────────────────
  const [splitTaskId, setSplitTaskId] = useState<string>('')
  const [splitCompleted, setSplitCompleted] = useState(false)
  const [splitChunks, setSplitChunks] = useState<SplitChunkInfo[]>([])
  const [originalAudioUrl, setOriginalAudioUrl] = useState<string>('')
  const [originalDurationSec, setOriginalDurationSec] = useState<number>(0)
  const [baseChunkDuration, setBaseChunkDuration] = useState<number>(5)
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string>('')
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string>('')

  // ─── Generation Results (Phase 2) ───────────────────────────────────
  const [chunks, setChunks] = useState<FaceSwapChunk[]>([])
  const [mergeTaskId, setMergeTaskId] = useState<string>('')
  const [resultVideoUrl, setResultVideoUrl] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState(0)

  // ─── Settings Change Tracking ───────────────────────────────────────
  const [settingsAtSplit, setSettingsAtSplit] = useState<{
    modelId: string, resolution: string, artStyle: string, prompt: string
  } | null>(null)

  const settingsChanged = splitCompleted && settingsAtSplit
    ? (settingsAtSplit.modelId !== modelId || settingsAtSplit.resolution !== resolution || settingsAtSplit.artStyle !== artStyle || settingsAtSplit.prompt !== prompt)
    : false

  const storageKey = `faceSwapState_${projectId}`

  // Chặn restore kết quả cũ từ DB sau khi user đã thao tác (split/generate/reset)
  const persistedRestoreLockedRef = useRef(false)

  // On mount, load state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (!saved) {
        if (persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
          setResultVideoUrl(persistedResultVideoUrl)
        }
        return
      }
      const data = JSON.parse(saved)
      if (data.modelId) setModelId(data.modelId)
      if (data.prompt) setPrompt(data.prompt)
      if (data.characterHint) setCharacterHint(data.characterHint)
      if (data.resolution) setResolution(data.resolution)
      if (data.artStyle) setArtStyle(data.artStyle)
      if (data.chunkDuration) setChunkDuration(data.chunkDuration)
      if (data.splitTaskId) setSplitTaskId(data.splitTaskId)
      if (data.splitCompleted) setSplitCompleted(data.splitCompleted)
      if (data.splitChunks) setSplitChunks(data.splitChunks)
      if (data.originalAudioUrl) setOriginalAudioUrl(data.originalAudioUrl)
      if (data.originalDurationSec) setOriginalDurationSec(data.originalDurationSec)
      if (data.baseChunkDuration) setBaseChunkDuration(data.baseChunkDuration)
      if (data.uploadedVideoUrl) setUploadedVideoUrl(normalizeUploadedMediaRef(data.uploadedVideoUrl))
      if (data.uploadedImageUrl) setUploadedImageUrl(normalizeUploadedMediaRef(data.uploadedImageUrl))
      if (data.chunks) setChunks(data.chunks)
      if (data.mergeTaskId) setMergeTaskId(data.mergeTaskId)
      if (data.resultVideoUrl) setResultVideoUrl(data.resultVideoUrl)
      if (data.settingsAtSplit) setSettingsAtSplit(data.settingsAtSplit)

      if (data.videoFileName && data.uploadedVideoUrl) {
        setSourceVideoFile(new File([], data.videoFileName, { type: 'video/mp4' }))
      }
      if (data.imageFileName && data.uploadedImageUrl) {
        setTargetImageFile(new File([], data.imageFileName, { type: 'image/jpeg' }))
      }

      if (!data.resultVideoUrl && persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
        setResultVideoUrl(persistedResultVideoUrl)
      }
    } catch (e) {
      console.error('Failed to load face swap state', e)
      if (persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
        setResultVideoUrl(persistedResultVideoUrl)
      }
    }
  }, [storageKey, persistedResultVideoUrl])

  useEffect(() => {
    if (!persistedResultVideoUrl || persistedRestoreLockedRef.current) return
    setResultVideoUrl((prev) => prev || persistedResultVideoUrl)
  }, [persistedResultVideoUrl])

  // Save state on change
  useEffect(() => {
    const data = {
      modelId, prompt, characterHint, resolution, artStyle, chunkDuration,
      splitTaskId, splitCompleted, splitChunks, originalAudioUrl, originalDurationSec, baseChunkDuration,
      uploadedVideoUrl, uploadedImageUrl, chunks, mergeTaskId, resultVideoUrl, settingsAtSplit,
      videoFileName: sourceVideoFile?.name || '',
      imageFileName: targetImageFile?.name || '',
    }
    localStorage.setItem(storageKey, JSON.stringify(data))
  }, [
    storageKey, modelId, prompt, characterHint, resolution, artStyle, chunkDuration,
    splitTaskId, splitCompleted, splitChunks, originalAudioUrl, originalDurationSec, baseChunkDuration,
    uploadedVideoUrl, uploadedImageUrl, chunks, mergeTaskId, resultVideoUrl, settingsAtSplit,
    sourceVideoFile?.name, targetImageFile?.name
  ])

  // ─── Upload Helper ──────────────────────────────────────────────────
  const uploadFile = async (file: File): Promise<string> => {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch('/api/asset-hub/upload-temp', {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json()
    return normalizeUploadedMediaRef(data.key || data.url)
  }

  // ─── Phase 1: Split ─────────────────────────────────────────────────
  const startSplit = useCallback(async () => {
    if (!sourceVideoFile && !uploadedVideoUrl) return
    try {
      persistedRestoreLockedRef.current = true
      setError('')
      setSplitCompleted(false)
      setSplitChunks([])
      setChunks([])
      setResultVideoUrl('')
      setMergeTaskId('')

      setIsUploading(true)
      let vUrl = uploadedVideoUrl
      if (!vUrl && sourceVideoFile) {
        vUrl = await uploadFile(sourceVideoFile)
        setUploadedVideoUrl(vUrl)
      }
      if (!vUrl) {
        throw new Error('Video is required')
      }

      // Upload image if available
      if (targetImageFile && !uploadedImageUrl) {
        const iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
      }

      setIsUploading(false)
      setIsSplitting(true)

      const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: vUrl,
          chunkDuration,
        })
      })
      
      if (!res.ok) throw new Error('Failed to start split task')
      const data = await res.json()
      
      setSplitTaskId(data.taskId)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setIsUploading(false)
      setIsSplitting(false)
    }
  }, [sourceVideoFile, targetImageFile, projectId, chunkDuration, uploadedVideoUrl, uploadedImageUrl])
  useEffect(() => {
    if (!splitTaskId || !isSplitting) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap?taskId=${splitTaskId}`)
        if (!res.ok) return
        const data = await res.json()
        setProgress(data.progress || 0)
        
        if (data.status === 'completed') {
          setIsSplitting(false)
          setSplitCompleted(true)
          if (data.result) {
            setSplitChunks(data.result.chunks || [])
            setOriginalAudioUrl(data.result.originalAudioUrl || '')
            setOriginalDurationSec(data.result.originalDurationSec || 0)
            setBaseChunkDuration(data.result.baseChunkDuration || chunkDuration)
          }
          // Snapshot current settings
          setSettingsAtSplit({ modelId, resolution, artStyle, prompt })
          clearInterval(interval)
        } else if (data.status === 'failed') {
          setIsSplitting(false)
          setError(data.error || 'Split failed')
          clearInterval(interval)
        }
      } catch (e) {
        console.error('Polling error', e)
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [splitTaskId, isSplitting, projectId, chunkDuration, modelId, resolution, artStyle, prompt])

  // ─── Phase 2: Generate ──────────────────────────────────────────────
  const startGenerate = useCallback(async () => {
    if (splitChunks.length === 0) return
    try {
      persistedRestoreLockedRef.current = true
      setError('')
      setIsGenerating(true)

      // Upload image if not yet uploaded
      let iUrl = uploadedImageUrl
      if (!iUrl && targetImageFile) {
        setIsUploading(true)
        iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
        setIsUploading(false)
      }
      if (!iUrl) {
        throw new Error('Target image is required')
      }

      const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_chunks',
          chunks: splitChunks.map(c => ({ originalUrl: c.originalUrl, index: c.index, duration: c.duration })),
          targetImageUrl: iUrl,
          modelId,
          prompt,
          characterHint,
          resolution,
          artStyle,
          baseChunkDuration,
          originalAudioUrl,
          originalDurationSec,
        })
      })
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(`[HTTP ${res.status}] ${errData.message || errData.error || JSON.stringify(errData) || 'Failed to start generation'}`)
      }
      const data = await res.json()
      
      // Create chunks with taskIds for polling
      const newChunks: FaceSwapChunk[] = splitChunks.map(sc => {
        const chunkTask = data.chunkTasks?.find((ct: { index: number, taskId: string }) => ct.index === sc.index)
        return {
          ...sc,
          taskId: chunkTask?.taskId || '',
          status: 'queued',
          progress: 0,
        }
      })
      setChunks(newChunks)
      // Update snapshot
      setSettingsAtSplit({ modelId, resolution, artStyle, prompt })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setIsGenerating(false)
      setIsUploading(false)
    }
  }, [splitChunks, targetImageFile, uploadedImageUrl, projectId, modelId, prompt, resolution, artStyle, baseChunkDuration, originalAudioUrl, originalDurationSec])

  // Keep a ref to chunks so the polling interval always sees latest state
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks

  // Track whether we have active chunks to poll
  const hasActiveChunks = chunks.length > 0 && chunks.some(c => !c.status || c.status === 'queued' || c.status === 'processing')

  // Stop generating flag when no more active chunks
  useEffect(() => {
    if (chunks.length > 0 && !hasActiveChunks && isGenerating) {
      setIsGenerating(false)
    }
  }, [chunks.length, hasActiveChunks, isGenerating])

  // Poll chunk tasks — only depends on hasActiveChunks and projectId, NOT on chunks
  useEffect(() => {
    if (!hasActiveChunks) return

    const interval = setInterval(async () => {
      const current = chunksRef.current
      const active = current.filter(c => !c.status || c.status === 'queued' || c.status === 'processing')
      if (active.length === 0) return

      for (const chunk of active) {
        try {
          const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap?taskId=${chunk.taskId}`)
          if (res.ok) {
            const data = await res.json()
            // Only update if something actually changed
            const prev = chunksRef.current.find(c => c.taskId === chunk.taskId)
            if (prev && (prev.status !== data.status || prev.progress !== data.progress || prev.resultVideoUrl !== data.result?.videoUrl)) {
              setChunks(cur => cur.map(c =>
                c.taskId === chunk.taskId
                  ? {
                      ...c,
                      status: data.status,
                      progress: data.progress,
                      resultVideoUrl: data.result?.videoUrl,
                      error: data.error
                    }
                  : c
              ))
            }
          }
        } catch {
          // ignore individual poll errors
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [hasActiveChunks, projectId])

  // ─── Retry Chunk ────────────────────────────────────────────────────
  const retryChunk = useCallback(async (chunkIndex: number, chunkOriginalUrl: string, duration: number) => {
    try {
      setResultVideoUrl('')
      setChunks(prev => prev.map(c => c.index === chunkIndex ? { ...c, status: 'queued', error: undefined, resultVideoUrl: undefined } : c))
      
      let iUrl = uploadedImageUrl
      if (!iUrl && targetImageFile) {
        iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
      }

      const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'chunk_retry',
          chunkOriginalUrl,
          chunkIndex,
          parentTaskId: `retry_${projectId}_${Date.now()}`,
          targetImageUrl: iUrl,
          modelId,
          prompt,
          characterHint,
          duration: duration || baseChunkDuration,
          baseChunkDuration,
          resolution,
          artStyle,
        })
      })
      if (!res.ok) throw new Error('Retry failed')
      const data = await res.json()
      
      setChunks(prev => prev.map(c => c.index === chunkIndex ? { ...c, taskId: data.taskId, status: 'queued' } : c))
    } catch (e) {
      console.error(e)
    }
  }, [projectId, uploadedImageUrl, targetImageFile, modelId, prompt, characterHint, baseChunkDuration, resolution, artStyle])

  // ─── Merge ──────────────────────────────────────────────────────────
  const startMerge = useCallback(async () => {
    try {
      setIsMerging(true)
      setResultVideoUrl('')
      const chunkUrls = chunks.sort((a, b) => a.index - b.index).map(c => c.resultVideoUrl).filter(Boolean) as string[]
      
      const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'merge',
          chunkUrls,
          originalAudioUrl,
          originalDurationSec
        })
      })
      if (!res.ok) throw new Error('Merge failed')
      const data = await res.json()
      setMergeTaskId(data.taskId)
    } catch (e) {
      console.error(e)
      setIsMerging(false)
    }
  }, [chunks, projectId, originalAudioUrl, originalDurationSec])

  // Poll merge task
  useEffect(() => {
    if (!mergeTaskId) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/novel-promotion/${projectId}/video-character-swap?taskId=${mergeTaskId}`)
        if (!res.ok) return
        const data = await res.json()
        
        if (data.status === 'completed') {
          setIsMerging(false)
          if (data.result && data.result.finalVideoUrl) {
            setResultVideoUrl(data.result.finalVideoUrl)
            onResultPersisted?.()
          }
          clearInterval(interval)
        } else if (data.status === 'failed') {
          setIsMerging(false)
          setError(data.error || 'Merge failed')
          clearInterval(interval)
        }
      } catch (e) {
        console.error('Polling error', e)
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [mergeTaskId, projectId, onResultPersisted])

  const clearPersistedResult = useCallback(async () => {
    try {
      await fetch(`/api/novel-promotion/${projectId}/video-character-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_chunk_result' }),
      })
    } catch {
      // ignore
    }
  }, [projectId])

  // ─── Stop: hủy mọi task đang chạy (split / chunk / merge) ──────────
  const isBusy = isSplitting || isMerging || hasActiveChunks

  const stopAll = useCallback(async () => {
    const taskIds = new Set<string>()
    if (splitTaskId && isSplitting) taskIds.add(splitTaskId)
    for (const chunk of chunksRef.current) {
      if (chunk.taskId && (!chunk.status || chunk.status === 'queued' || chunk.status === 'processing')) {
        taskIds.add(chunk.taskId)
      }
    }
    if (mergeTaskId && isMerging) taskIds.add(mergeTaskId)

    await Promise.allSettled(
      [...taskIds].map((id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' })),
    )

    setIsSplitting(false)
    setIsGenerating(false)
    setIsMerging(false)
    setMergeTaskId('')
    setChunks((cur) => cur.map((c) =>
      (!c.status || c.status === 'queued' || c.status === 'processing')
        ? { ...c, status: 'canceled', error: 'Đã dừng bởi người dùng' }
        : c,
    ))
  }, [splitTaskId, isSplitting, mergeTaskId, isMerging])

  // ─── Reset ──────────────────────────────────────────────────────────
  const reset = useCallback(async () => {
    persistedRestoreLockedRef.current = true
    setSourceVideoFile(null)
    setTargetImageFile(null)
    setResultVideoUrl('')
    setError('')
    setSplitTaskId('')
    setSplitCompleted(false)
    setSplitChunks([])
    setUploadedVideoUrl('')
    setUploadedImageUrl('')
    setMergeTaskId('')
    setPrompt('')
    setCharacterHint('')
    setProgress(0)
    setChunks([])
    setOriginalAudioUrl('')
    setOriginalDurationSec(0)
    setSettingsAtSplit(null)
    localStorage.removeItem(storageKey)
    await clearPersistedResult()
  }, [storageKey, clearPersistedResult])

  return {
    // User inputs
    sourceVideoFile, setSourceVideoFile,
    targetImageFile, setTargetImageFile,
    modelId, setModelId,
    prompt, setPrompt,
    characterHint, setCharacterHint,
    resolution, setResolution,
    artStyle, setArtStyle,
    chunkDuration, setChunkDuration,
    // Phase states
    isUploading, setIsUploading, isSplitting, isGenerating, isMerging,
    // Split results
    splitCompleted, splitChunks,
    // Generation results
    chunks, progress, resultVideoUrl, setResultVideoUrl, error, setError,
    // Settings tracking
    settingsChanged,
    uploadedVideoUrl, setUploadedVideoUrl, uploadedImageUrl, setUploadedImageUrl,
    // Actions
    isBusy, uploadFile, startSplit, startGenerate, startMerge, stopAll, retryChunk, reset,
  }
}
