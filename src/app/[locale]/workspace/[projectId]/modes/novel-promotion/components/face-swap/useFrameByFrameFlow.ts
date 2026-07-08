import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react'
import { loadVideoEditSessionRemote, saveVideoEditSessionRemote } from './useVideoEditPersistence'

export type ExtractedFrame = {
  index: number
  url: string
}

export type ProcessedFrame = ExtractedFrame & {
  taskId: string
  status?: string
  progress?: number
  resultUrl?: string
  error?: string
}

export type FrameExtractMeta = {
  frameKeys: string[]
  totalFrames: number
  targetFps: number
  originalDurationSec: number
  audioUrl?: string
  motionDataKey?: string
}

/**
 * Task cũ (trước fix backend) có thể trả resultUrl dạng data: base64 nhiều MB.
 * Không được để lọt vào localStorage (quota ~5MB) hay giữ trong state lâu dài.
 */
function sanitizeFrames<T extends { resultUrl?: string }>(frames: T[]): T[] {
  return frames.map((f) =>
    f.resultUrl && f.resultUrl.startsWith('data:') ? { ...f, resultUrl: undefined } : f,
  )
}

function isProcessedFrameJobActive(frame: ProcessedFrame): boolean {
  if (frame.status === 'completed' || frame.status === 'failed' || frame.status === 'canceled') {
    return false
  }
  if (frame.status === 'processing') return true
  if (frame.status === 'queued') return Boolean(frame.taskId)
  return false
}

function processedFramesMatchExtract(
  frames: ProcessedFrame[],
  frameKeys: string[],
  extractTaskId: string,
  aiSourceExtractTaskId: string,
): boolean {
  if (!extractTaskId || aiSourceExtractTaskId !== extractTaskId) return false
  if (frames.length !== frameKeys.length || frameKeys.length === 0) return false
  return frames.every((f) => {
    const key = frameKeys[f.index]
    return Boolean(key) && f.url === key
  })
}

function clearFbfAiState(setters: {
  setProcessedFrames: (v: ProcessedFrame[]) => void
  setMergeTaskId: (v: string) => void
  setResultVideoUrl: (v: string) => void
  setAiSourceExtractTaskId: (v: string) => void
  setIsGenerating: (v: boolean) => void
  setIsMerging: (v: boolean) => void
  setFramesWereRetried: (v: boolean) => void
  generateInitiatedRef: MutableRefObject<boolean>
}) {
  setters.setProcessedFrames([])
  setters.setMergeTaskId('')
  setters.setResultVideoUrl('')
  setters.setAiSourceExtractTaskId('')
  setters.setIsGenerating(false)
  setters.setIsMerging(false)
  setters.setFramesWereRetried(false)
  setters.generateInitiatedRef.current = false
}

export type FrameClassification = {
  index: number
  hasCharacter: boolean
  reason?: string
}

export function normalizeFrameClassifications(
  frameCount: number,
  partial: FrameClassification[] = [],
  defaultHasCharacter = true,
): FrameClassification[] {
  if (frameCount <= 0) return []
  const byIndex = new Map(partial.map((c) => [c.index, c]))
  return Array.from({ length: frameCount }, (_, index) => {
    const existing = byIndex.get(index)
    return existing ?? { index, hasCharacter: defaultHasCharacter, reason: 'default' }
  })
}

/** Giới hạn an toàn — tránh API generate_frames timeout khi tạo quá nhiều task */
export const FBF_MAX_FRAMES = 120

async function fbfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        'Không kết nối được server (failed to fetch). Kiểm tra app đang chạy: http://localhost:13000',
      )
    }
    throw err
  }
}

export function useFrameByFrameFlow(
  projectId: string,
  options?: {
    persistedResultVideoUrl?: string | null
    onResultPersisted?: () => void
  },
) {
  const MERGE_RETRY_AFTER_MS = 60_000
  const MERGE_TIMEOUT_MS = 5 * 60_000

  const [isExtracting, setIsExtracting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [extractTaskId, setExtractTaskId] = useState('')
  const [extractCompleted, setExtractCompleted] = useState(false)
  const [extractMeta, setExtractMeta] = useState<FrameExtractMeta | null>(null)
  const [extractedFrames, setExtractedFrames] = useState<ExtractedFrame[]>([])
  const [processedFrames, setProcessedFrames] = useState<ProcessedFrame[]>([])
  const [mergeTaskId, setMergeTaskId] = useState('')
  const [resultVideoUrl, setResultVideoUrl] = useState('')
  const [error, setError] = useState('')
  const [extractProgress, setExtractProgress] = useState(0)
  const [isClassifying, setIsClassifying] = useState(false)
  const [classifyTaskId, setClassifyTaskId] = useState('')
  const [frameClassifications, setFrameClassifications] = useState<FrameClassification[]>([])
  const [aiSourceExtractTaskId, setAiSourceExtractTaskId] = useState('')
  const [framesWereRetried, setFramesWereRetried] = useState(false)
  const mergeStartedAtRef = useRef<number | null>(null)
  const mergeRetriedRef = useRef(false)
  const generateInitiatedRef = useRef(false)
  // Chặn restore kết quả cũ từ DB sau khi user đã thao tác (cắt lại / AI / reset).
  // Nếu không, project query resolve muộn sẽ đè URL cũ lên state vừa xóa.
  const persistedRestoreLockedRef = useRef(false)
  const didHydrateFromStorageRef = useRef(false)
  const didHydrateFromDbRef = useRef(false)
  const dbSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const storageKey = `fbfState_${projectId}`
  const persistedResultVideoUrl = options?.persistedResultVideoUrl
  const onResultPersisted = options?.onResultPersisted

  const applyFbfSessionFromData = useCallback((data: Record<string, unknown>) => {
    if (data.extractTaskId) setExtractTaskId(data.extractTaskId as string)
    if (data.extractCompleted) setExtractCompleted(data.extractCompleted as boolean)
    if (data.extractMeta) setExtractMeta(data.extractMeta as FrameExtractMeta)
    if (data.extractedFrames) setExtractedFrames(data.extractedFrames as ExtractedFrame[])
    if (data.resultVideoUrl) setResultVideoUrl(data.resultVideoUrl as string)

    const frameKeyCount = (data.extractMeta as FrameExtractMeta | undefined)?.frameKeys?.length ?? 0
    const savedFrameKeys = ((data.extractMeta as FrameExtractMeta | undefined)?.frameKeys ?? []) as string[]
    const rawClassifications = Array.isArray(data.frameClassifications) ? data.frameClassifications : []
    if (frameKeyCount > 0 && data.extractCompleted) {
      setFrameClassifications(normalizeFrameClassifications(frameKeyCount, rawClassifications as FrameClassification[]))
    } else if (rawClassifications.length > 0) {
      setFrameClassifications(rawClassifications as FrameClassification[])
    }
    const savedProcessed = Array.isArray(data.processedFrames) ? data.processedFrames : []
    const processedFramesValid = processedFramesMatchExtract(
      savedProcessed as ProcessedFrame[],
      savedFrameKeys,
      (data.extractTaskId as string) ?? '',
      (data.aiSourceExtractTaskId as string) ?? '',
    )

    if (processedFramesValid) {
      setProcessedFrames(sanitizeFrames(savedProcessed as ProcessedFrame[]))
      if (data.mergeTaskId) setMergeTaskId(data.mergeTaskId as string)
      if (data.aiSourceExtractTaskId) setAiSourceExtractTaskId(data.aiSourceExtractTaskId as string)
      const hasResumableJobs = (savedProcessed as ProcessedFrame[]).some((f) => isProcessedFrameJobActive(f))
      if (hasResumableJobs) {
        generateInitiatedRef.current = true
        setIsGenerating(true)
      }
    }

    if (data.classifyTaskId && frameKeyCount > 0 && rawClassifications.length < frameKeyCount) {
      setClassifyTaskId(data.classifyTaskId as string)
      setIsClassifying(true)
    } else if (data.classifyTaskId) {
      setClassifyTaskId(data.classifyTaskId as string)
    }
  }, [])

  const clearAiState = useCallback(() => {
    clearFbfAiState({
      setProcessedFrames,
      setMergeTaskId,
      setResultVideoUrl,
      setAiSourceExtractTaskId,
      setIsGenerating,
      setIsMerging,
      setFramesWereRetried,
      generateInitiatedRef,
    })
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false
  }, [])

  // Chỉ hydrate localStorage một lần khi mount — tránh ghi đè state sau cắt lại / Start AI
  useEffect(() => {
    if (didHydrateFromStorageRef.current) return
    didHydrateFromStorageRef.current = true

    try {
      const saved = localStorage.getItem(storageKey)
      if (!saved) {
        if (persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
          setResultVideoUrl(persistedResultVideoUrl)
        }
        return
      }
      const data = JSON.parse(saved) as Record<string, unknown>
      applyFbfSessionFromData(data)

      if (!data.resultVideoUrl && persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
        setResultVideoUrl(persistedResultVideoUrl)
      }
    } catch (e) {
      console.error('Failed to load FBF state', e)
      if (persistedResultVideoUrl && !persistedRestoreLockedRef.current) {
        setResultVideoUrl(persistedResultVideoUrl)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once on mount
  }, [storageKey])

  // Hydrate từ DB nếu phiên server mới hơn localStorage
  useEffect(() => {
    if (!projectId || didHydrateFromDbRef.current) return
    didHydrateFromDbRef.current = true

    void (async () => {
      try {
        const dbSession = await loadVideoEditSessionRemote(projectId, 'fbf')
        if (!dbSession || persistedRestoreLockedRef.current) return

        const localRaw = localStorage.getItem(storageKey)
        const localSession = localRaw ? JSON.parse(localRaw) as Record<string, unknown> : null
        const dbUpdated = typeof dbSession.updatedAt === 'string'
          ? new Date(dbSession.updatedAt).getTime()
          : 0
        const localUpdated = typeof localSession?.updatedAt === 'string'
          ? new Date(localSession.updatedAt).getTime()
          : 0
        const localHasWork = Boolean(localSession?.extractTaskId || localSession?.extractCompleted)

        if (dbUpdated > localUpdated || !localHasWork) {
          applyFbfSessionFromData(dbSession)
          if (!dbSession.resultVideoUrl && persistedResultVideoUrl) {
            setResultVideoUrl(persistedResultVideoUrl)
          }
        }
      } catch (e) {
        console.error('Failed to load FBF session from DB', e)
      }
    })()
  }, [projectId, storageKey, applyFbfSessionFromData, persistedResultVideoUrl])

  useEffect(() => {
    if (!persistedResultVideoUrl || persistedRestoreLockedRef.current) return
    setResultVideoUrl((prev) => prev || persistedResultVideoUrl)
  }, [persistedResultVideoUrl])

  useEffect(() => {
    const data = {
      extractTaskId,
      extractCompleted,
      extractMeta,
      extractedFrames,
      processedFrames: sanitizeFrames(processedFrames),
      classifyTaskId,
      frameClassifications,
      aiSourceExtractTaskId,
      mergeTaskId,
      resultVideoUrl: resultVideoUrl.startsWith('data:') ? '' : resultVideoUrl,
      updatedAt: new Date().toISOString(),
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(data))
    } catch {
      // Quota exceeded — bỏ qua, không để crash render
    }

    if (dbSaveTimerRef.current) clearTimeout(dbSaveTimerRef.current)
    dbSaveTimerRef.current = setTimeout(() => {
      void saveVideoEditSessionRemote(projectId, 'fbf', data).catch(() => {})
    }, 2000)

    return () => {
      if (dbSaveTimerRef.current) clearTimeout(dbSaveTimerRef.current)
    }
  }, [projectId, storageKey, extractTaskId, extractCompleted, extractMeta, extractedFrames, processedFrames, classifyTaskId, frameClassifications, aiSourceExtractTaskId, mergeTaskId, resultVideoUrl])

  const startExtract = useCallback(async (videoUrl: string, targetFps: number) => {
    persistedRestoreLockedRef.current = true
    setError('')
    setExtractCompleted(false)
    setExtractMeta(null)
    setExtractedFrames([])
    setFrameClassifications([])
    setClassifyTaskId('')
    setIsExtracting(true)
    setIsClassifying(false)
    setExtractProgress(0)
    clearAiState()
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        extractTaskId: '',
        extractCompleted: false,
        extractMeta: null,
        extractedFrames: [],
        processedFrames: [],
        classifyTaskId: '',
        frameClassifications: [],
        aiSourceExtractTaskId: '',
        mergeTaskId: '',
        resultVideoUrl: '',
      }))
    } catch {
      // ignore quota
    }

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'extract',
        projectId,
        videoUrl,
        targetFps,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setIsExtracting(false)
      throw new Error(err.message || 'Failed to start frame extraction')
    }

    const data = await res.json()
    setExtractTaskId(data.taskId)
  }, [projectId, clearAiState, storageKey])

  useEffect(() => {
    if (!extractTaskId || !isExtracting) return

    const interval = setInterval(async () => {
      try {
        const res = await fbfFetch(`/api/video-frame-process?taskId=${extractTaskId}`)
        if (!res.ok) return
        const data = await res.json()
        setExtractProgress(data.progress || 0)

        if (data.status === 'canceled') {
          setIsExtracting(false)
          clearInterval(interval)
          return
        }
        if (data.status === 'completed' && data.result) {
          const result = data.result as {
            frameKeys?: string[]
            totalFrames?: number
            targetFps?: number
            originalDurationSec?: number
            audioUrl?: string
            motionData?: string
          }

          const frameKeys = result.frameKeys || []
          const meta: FrameExtractMeta = {
            frameKeys,
            totalFrames: result.totalFrames || frameKeys.length,
            targetFps: result.targetFps || 8,
            originalDurationSec: result.originalDurationSec || 0,
            audioUrl: result.audioUrl,
            motionDataKey: result.motionData,
          }

          setExtractMeta(meta)
          setExtractedFrames(frameKeys.map((url, index) => ({ index, url })))
          setFrameClassifications(
            frameKeys.map((_, index) => ({ index, hasCharacter: true, reason: 'default' })),
          )
          clearAiState()
          setExtractCompleted(true)
          setIsExtracting(false)
          clearInterval(interval)
        } else if (data.status === 'failed') {
          setIsExtracting(false)
          setError(data.error || 'Frame extraction failed')
          clearInterval(interval)
        }
      } catch (e) {
        console.error('Extract polling error', e)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [extractTaskId, isExtracting, clearAiState])

  const startClassify = useCallback(async (params: {
    characterHint?: string
    referenceImageUrl?: string
  }) => {
    if (!extractMeta || extractMeta.frameKeys.length === 0) {
      throw new Error('No extracted frames available')
    }

    setError('')
    setIsClassifying(true)
    // Giữ badge SWAP/SKIP hiện tại trong lúc detect chạy lại
    setProcessedFrames([])
    setMergeTaskId('')
    setResultVideoUrl('')
    setIsGenerating(false)
    setIsMerging(false)
    setAiSourceExtractTaskId('')
    generateInitiatedRef.current = false
    setFramesWereRetried(false)
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'classify_frames',
        projectId,
        frameKeys: extractMeta.frameKeys,
        characterHint: params.characterHint,
        referenceImageUrl: params.referenceImageUrl,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setIsClassifying(false)
      throw new Error(err.message || 'Failed to start frame classification')
    }

    const data = await res.json()
    setClassifyTaskId(data.taskId)
  }, [extractMeta, projectId])

  useEffect(() => {
    if (!classifyTaskId || !isClassifying) return

    const frameCount = extractMeta?.frameKeys.length ?? 0

    const interval = setInterval(async () => {
      try {
        const res = await fbfFetch(`/api/video-frame-process?taskId=${classifyTaskId}`)
        if (!res.ok) return
        const data = await res.json()

        if (data.status === 'completed') {
          if (data.result?.classifications) {
            const incoming = data.result.classifications as FrameClassification[]
            setFrameClassifications(
              normalizeFrameClassifications(frameCount, incoming, true),
            )
          } else {
            setError('Detect hoàn tất nhưng không có kết quả — dùng badge SWAP/SKIP thủ công')
          }
          setIsClassifying(false)
          clearInterval(interval)
        } else if (data.status === 'failed' || data.status === 'canceled') {
          setIsClassifying(false)
          if (data.status === 'failed') {
            setError(data.error || 'Frame classification failed')
          }
          clearInterval(interval)
        }
      } catch (e) {
        console.error('Classify polling error', e)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [classifyTaskId, isClassifying, extractMeta?.frameKeys.length])

  const startGenerate = useCallback(async (params: {
    modelId: string
    prompt: string
    referenceImageUrl?: string
    characterHint?: string
    processingMode: 'img2img' | 'v2v'
    artStyle?: string
    temporalMode: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
    filterCharacterFrames?: boolean
  }) => {
    if (!extractMeta || extractMeta.frameKeys.length === 0) {
      throw new Error('No extracted frames available')
    }
    if (extractMeta.frameKeys.length > FBF_MAX_FRAMES) {
      throw new Error(
        `Quá nhiều frame (${extractMeta.frameKeys.length}). Tối đa ${FBF_MAX_FRAMES} — giảm FPS hoặc dùng video ngắn hơn.`,
      )
    }

    persistedRestoreLockedRef.current = true
    setError('')
    setIsGenerating(true)
    setResultVideoUrl('')
    setProcessedFrames([])
    setMergeTaskId('')
    setIsMerging(false)
    setAiSourceExtractTaskId(extractTaskId)
    setFramesWereRetried(false)
    generateInitiatedRef.current = true
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false

    const frameCount = extractMeta.frameKeys.length
    const resolvedClassifications = normalizeFrameClassifications(frameCount, frameClassifications)

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'generate_frames',
        projectId,
        frameKeys: extractMeta.frameKeys,
        targetFps: extractMeta.targetFps,
        originalDurationSec: extractMeta.originalDurationSec,
        audioUrl: extractMeta.audioUrl,
        motionDataKey: extractMeta.motionDataKey,
        filterCharacterFrames: params.filterCharacterFrames ?? true,
        classifications: resolvedClassifications,
        characterHint: params.characterHint,
        ...params,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setIsGenerating(false)
      generateInitiatedRef.current = false
      setAiSourceExtractTaskId('')
      throw new Error(err.message || 'Failed to start frame generation')
    }

    const data = await res.json()
    setMergeTaskId(data.mergeTaskId)

    const frames: ProcessedFrame[] = extractMeta.frameKeys.map((url, index) => {
      const chunkTask = data.chunkTasks?.find((ct: { index: number; taskId: string }) => ct.index === index)
      return {
        index,
        url,
        taskId: chunkTask?.taskId || '',
        status: 'queued',
        progress: 0,
      }
    })
    setProcessedFrames(frames)
  }, [extractMeta, extractTaskId, projectId, frameClassifications])

  const toggleFrameClassification = useCallback((frameIndex: number) => {
    setFrameClassifications((prev) => {
      const count = extractMeta?.frameKeys.length ?? prev.length
      const normalized = normalizeFrameClassifications(count, prev)
      return normalized.map((c) =>
        c.index === frameIndex
          ? { ...c, hasCharacter: !c.hasCharacter, reason: 'manual_override' }
          : c,
      )
    })
  }, [extractMeta?.frameKeys.length])

  const frameCount = extractMeta?.frameKeys.length ?? 0
  const normalizedClassifications = normalizeFrameClassifications(frameCount, frameClassifications)
  const detectCompleted = Boolean(classifyTaskId) && !isClassifying
  const processableFrameCount = normalizedClassifications.filter((c) => c.hasCharacter).length
  const hasActiveFrameJobs = aiSourceExtractTaskId === extractTaskId
    && processedFrames.some(isProcessedFrameJobActive)
  const frameSelectionReady = extractCompleted && frameCount > 0
  const classifyCompleted = frameSelectionReady
  const allFramesCompleted = processedFrames.length > 0
    && processedFrames.every((f) => f.status === 'completed' && f.resultUrl)
  const canStartAi = frameSelectionReady
    && processableFrameCount > 0
    && !isGenerating
    && !hasActiveFrameJobs
  const canMerge = allFramesCompleted
    && !hasActiveFrameJobs
    && !isMerging
    && (Boolean(mergeTaskId) || processedFrames.every((f) => Boolean(f.taskId)))

  const processedFramesRef = useRef(processedFrames)
  processedFramesRef.current = processedFrames

  const hasActiveFrames = processedFrames.length > 0
    && processedFrames.some(isProcessedFrameJobActive)

  useEffect(() => {
    if (processedFrames.length > 0 && !hasActiveFrames && isGenerating) {
      setIsGenerating(false)
    }
  }, [processedFrames.length, hasActiveFrames, isGenerating])

  useEffect(() => {
    if (!hasActiveFrames) return

    const interval = setInterval(async () => {
      const current = processedFramesRef.current
      const active = current.filter(isProcessedFrameJobActive)
      if (active.length === 0) return

      for (const frame of active) {
        if (!frame.taskId) continue
        try {
          const res = await fbfFetch(`/api/video-frame-process?taskId=${frame.taskId}`)
          if (!res.ok) continue
          const data = await res.json()
          const prev = processedFramesRef.current.find((f) => f.taskId === frame.taskId)
          const resultUrl = data.result?.processedImageUrl || data.result?.processedFrameKey
          if (prev && (prev.status !== data.status || prev.progress !== data.progress || prev.resultUrl !== resultUrl)) {
            setProcessedFrames((cur) => cur.map((f) =>
              f.taskId === frame.taskId
                ? {
                    ...f,
                    status: data.status,
                    progress: data.progress,
                    resultUrl,
                    error: data.error,
                  }
                : f,
            ))
          }
        } catch {
          // ignore poll errors
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [hasActiveFrames])

  const uploadFrameImage = useCallback(async (file: File): Promise<string> => {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fbfFetch('/api/asset-hub/upload-temp', {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      throw new Error('Upload ảnh thất bại')
    }
    const data = await res.json()
    const key = (data.key || data.url || '') as string
    return key.replace(/^\/+/, '')
  }, [])

  const replaceFrameResult = useCallback(async (frameIndex: number, file: File) => {
    const frame = processedFramesRef.current.find((f) => f.index === frameIndex)
    if (!frame) {
      throw new Error('Không tìm thấy frame')
    }
    if (frame.status === 'queued' || frame.status === 'processing') {
      throw new Error('Đợi frame xử lý xong trước khi thay ảnh')
    }

    const resultKey = await uploadFrameImage(file)

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'replace_frame_result',
        projectId,
        frameIndex,
        taskId: frame.taskId || undefined,
        resultKey,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || 'Không thể lưu ảnh thay thế')
    }

    setProcessedFrames((prev) => prev.map((f) =>
      f.index === frameIndex
        ? { ...f, resultUrl: resultKey, status: 'completed', progress: 100, error: undefined }
        : f,
    ))
    setResultVideoUrl('')
    setFramesWereRetried(true)
  }, [projectId, uploadFrameImage])

  const retryFrame = useCallback(async (
    frameIndex: number,
    params: {
      modelId: string
      prompt: string
      referenceImageUrl?: string
      processingMode: 'img2img' | 'v2v'
      artStyle?: string
      temporalMode: 'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'
    },
  ) => {
    if (!extractMeta) throw new Error('No extracted frames')

    const normalized = normalizeFrameClassifications(extractMeta.frameKeys.length, frameClassifications)
    const classification = normalized.find((c) => c.index === frameIndex)
    const passthrough = classification?.hasCharacter === false
    const prevProcessed = processedFramesRef.current.find((f) => f.index === frameIndex - 1)

    setProcessedFrames((prev) => prev.map((f) =>
      f.index === frameIndex
        ? { ...f, status: 'queued', progress: 0, resultUrl: undefined, error: undefined }
        : f,
    ))
    setResultVideoUrl('')
    setFramesWereRetried(true)

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'frame_retry',
        projectId,
        frameIndex,
        frameKey: extractMeta.frameKeys[frameIndex],
        prevFrameKey: frameIndex > 0 ? extractMeta.frameKeys[frameIndex - 1] : undefined,
        prevProcessedFrameKey: prevProcessed?.resultUrl,
        totalFrames: extractMeta.totalFrames,
        passthrough,
        ...params,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || 'Frame retry failed')
    }

    const data = await res.json()
    setProcessedFrames((prev) => prev.map((f) =>
      f.index === frameIndex ? { ...f, taskId: data.taskId, status: 'queued' } : f,
    ))
  }, [extractMeta, projectId, frameClassifications])

  const remergeVideo = useCallback(async () => {
    if (!extractMeta) throw new Error('No extract metadata')
    const current = processedFramesRef.current
    const taskIds = current.map((f) => f.taskId).filter(Boolean)
    if (taskIds.length !== current.length) {
      throw new Error('Missing frame task IDs for remerge')
    }
    if (!current.every((f) => f.status === 'completed' && f.resultUrl)) {
      throw new Error('All frames must be completed before remerge')
    }

    setResultVideoUrl('')
    setError('')
    mergeStartedAtRef.current = Date.now()
    mergeRetriedRef.current = false
    setIsMerging(true)

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remerege_frames',
        projectId,
        frameTaskIds: taskIds,
        targetFps: extractMeta.targetFps,
        originalDurationSec: extractMeta.originalDurationSec,
        audioUrl: extractMeta.audioUrl,
        totalFrames: extractMeta.totalFrames,
      }),
    })

    if (!res.ok) {
      setIsMerging(false)
      throw new Error('Failed to start remerge')
    }

    const data = await res.json()
    setMergeTaskId(data.mergeTaskId)
  }, [extractMeta, projectId])

  const startMerge = useCallback(async () => {
    if (!mergeTaskId) return
    setIsMerging(true)
    setError('')

    const res = await fbfFetch('/api/video-frame-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'merge',
        projectId,
        mergeTaskId,
      }),
    })

    if (!res.ok) {
      setIsMerging(false)
      throw new Error('Failed to start merge')
    }
  }, [mergeTaskId, projectId])

  const mergeVideo = useCallback(async () => {
    if (!allFramesCompleted) {
      throw new Error('Chờ tất cả frame AI hoàn thành trước khi ghép')
    }

    setResultVideoUrl('')
    setError('')

    if (framesWereRetried || !mergeTaskId) {
      await remergeVideo()
      return
    }

    mergeStartedAtRef.current = Date.now()
    mergeRetriedRef.current = false
    setIsMerging(true)
    await startMerge()
  }, [allFramesCompleted, framesWereRetried, mergeTaskId, startMerge, remergeVideo])

  useEffect(() => {
    if (!mergeTaskId || !isMerging) return


    const interval = setInterval(async () => {
      try {
        const startedAt = mergeStartedAtRef.current || Date.now()
        const elapsedMs = Date.now() - startedAt
        if (elapsedMs > MERGE_RETRY_AFTER_MS && !mergeRetriedRef.current) {
          mergeRetriedRef.current = true
          await fbfFetch('/api/video-frame-process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'merge',
              projectId,
              mergeTaskId,
            }),
          })
        }
        if (elapsedMs > MERGE_TIMEOUT_MS) {
          setIsMerging(false)
          setError('Merge timed out. Please retry processing or start a new run.')
          clearInterval(interval)
          return
        }

        const res = await fbfFetch(`/api/video-frame-process?taskId=${mergeTaskId}`)
        if (!res.ok) return
        const data = await res.json()

        if (data.status === 'completed') {
          setIsMerging(false)
          mergeStartedAtRef.current = null
          mergeRetriedRef.current = false
          const resultUrl = data.result?.resultUrl || data.result?.videoUrl || data.result?.finalVideoUrl
          if (resultUrl) {
            setResultVideoUrl(resultUrl)
            onResultPersisted?.()
          }
          clearInterval(interval)
        } else if (data.status === 'canceled') {
          setIsMerging(false)
          mergeStartedAtRef.current = null
          mergeRetriedRef.current = false
          clearInterval(interval)
        } else if (data.status === 'failed') {
          setIsMerging(false)
          mergeStartedAtRef.current = null
          mergeRetriedRef.current = false
          setError(data.error || 'Merge failed')
          clearInterval(interval)
        }
      } catch (e) {
        console.error('Merge polling error', e)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [mergeTaskId, isMerging, projectId, onResultPersisted])

  const clearPersistedResult = useCallback(async () => {
    try {
      await fbfFetch('/api/video-frame-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_fbf_result', projectId }),
      })
    } catch {
      // ignore — local state still resets
    }
  }, [projectId])

  const isBusy = isExtracting || isClassifying || isGenerating || isMerging || hasActiveFrames

  const resetForReclassify = useCallback(() => {
    const count = extractMeta?.frameKeys.length ?? 0
    setFrameClassifications(
      count > 0
        ? Array.from({ length: count }, (_, index) => ({ index, hasCharacter: true, reason: 'default' }))
        : [],
    )
    setClassifyTaskId('')
    setIsClassifying(false)
    setProcessedFrames([])
    setMergeTaskId('')
    setResultVideoUrl('')
    setIsGenerating(false)
    setIsMerging(false)
    setAiSourceExtractTaskId('')
    generateInitiatedRef.current = false
    setFramesWereRetried(false)
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false
  }, [extractMeta?.frameKeys.length])

  const stopAll = useCallback(async () => {
    const taskIds = new Set<string>()
    if (extractTaskId && isExtracting) taskIds.add(extractTaskId)
    if (classifyTaskId && isClassifying) taskIds.add(classifyTaskId)
    for (const frame of processedFramesRef.current) {
      if (frame.taskId && isProcessedFrameJobActive(frame)) {
        taskIds.add(frame.taskId)
      }
    }
    if (mergeTaskId) taskIds.add(mergeTaskId)

    await Promise.allSettled(
      [...taskIds].map((id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' })),
    )

    setIsExtracting(false)
    setIsClassifying(false)
    setIsGenerating(false)
    setIsMerging(false)
    generateInitiatedRef.current = false
    // Xóa mergeTaskId để auto-merge không tự khởi động lại sau khi dừng
    setMergeTaskId('')
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false
    setProcessedFrames((cur) => cur.map((f) =>
      isProcessedFrameJobActive(f)
        ? { ...f, status: 'canceled', error: 'Đã dừng bởi người dùng' }
        : f,
    ))
  }, [extractTaskId, isExtracting, classifyTaskId, isClassifying, mergeTaskId])

  const resetFbf = useCallback(async () => {
    persistedRestoreLockedRef.current = true
    setIsExtracting(false)
    setIsClassifying(false)
    setIsGenerating(false)
    setIsMerging(false)
    setExtractTaskId('')
    setClassifyTaskId('')
    setFrameClassifications([])
    setAiSourceExtractTaskId('')
    setFramesWereRetried(false)
    setExtractCompleted(false)
    setExtractMeta(null)
    setExtractedFrames([])
    setProcessedFrames([])
    setMergeTaskId('')
    setResultVideoUrl('')
    setError('')
    setExtractProgress(0)
    mergeStartedAtRef.current = null
    mergeRetriedRef.current = false
    generateInitiatedRef.current = false
    localStorage.removeItem(storageKey)
    void saveVideoEditSessionRemote(projectId, 'fbf', {}).catch(() => {})
    await clearPersistedResult()
  }, [storageKey, clearPersistedResult])

  return {
    isExtracting,
    isClassifying,
    isGenerating,
    isMerging,
    extractCompleted,
    classifyCompleted,
    detectCompleted,
    canStartAi,
    canMerge,
    processableFrameCount,
    hasActiveFrameJobs,
    frameClassifications,
    toggleFrameClassification,
    extractMeta,
    extractedFrames,
    processedFrames,
    mergeTaskId,
    resultVideoUrl,
    setResultVideoUrl,
    error,
    setError,
    extractProgress,
    allFramesCompleted,
    isBusy,
    startExtract,
    startClassify,
    startGenerate,
    retryFrame,
    replaceFrameResult,
    remergeVideo,
    mergeVideo,
    resetForReclassify,
    startMerge,
    stopAll,
    resetFbf,
  }
}
