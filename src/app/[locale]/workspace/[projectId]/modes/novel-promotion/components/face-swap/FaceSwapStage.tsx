import { useRef, useMemo, useState, useEffect } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { toast } from 'react-hot-toast'
import GlassSurface from '@/components/ui/primitives/GlassSurface'
import GlassButton from '@/components/ui/primitives/GlassButton'
import GlassTextarea from '@/components/ui/primitives/GlassTextarea'
import GlassInput from '@/components/ui/primitives/GlassInput'
import { useVideoCharacterSwap } from './useVideoCharacterSwap'
import { useFrameByFrameFlow, normalizeFrameClassifications } from './useFrameByFrameFlow'
import { AppIcon } from '@/components/ui/icons'
import { useParams } from 'next/navigation'
import { useWorkspaceStageRuntime } from '../../WorkspaceStageRuntimeContext'
import { VIDEO_RESOLUTIONS, ART_STYLES, FBF_CHARACTER_SWAP_PROMPTS, CHUNK_MOTION_PROMPT_PRESETS, getFbfPromptPreset, getChunkMotionPromptPreset } from '@/lib/constants'
import { useUserModels, useProjectData } from '@/lib/query/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { ModelCapabilityDropdown } from '@/components/ui/config-modals/ModelCapabilityDropdown'
import { BackendLogViewer } from '@/components/ui/BackendLogViewer'
import { resolvePlayableImageUrl, resolvePlayableVideoUrl } from '@/lib/media/playable-url'
import { FBF_MAX_FRAMES } from './useFrameByFrameFlow'

export interface FaceSwapStageProps {
  initialEngine?: 'chunk' | 'fbf'
}

export default function FaceSwapStage({ initialEngine = 'chunk' }: FaceSwapStageProps = {}) {
  const params = useParams()
  const projectId = params?.projectId as string
  const locale = useLocale() as 'zh' | 'en'
  const t = useTranslations('video')
  const { videoModel: projectVideoModel, userVideoModels, artStyle: projectArtStyle } = useWorkspaceStageRuntime()
  const userModelsQuery = useUserModels()
  const projectQuery = useProjectData(projectId)
  const queryClient = useQueryClient()
  const projectEditModel = projectQuery.data?.novelPromotionData?.editModel as string | undefined
  const persistedFbfResultUrl = projectQuery.data?.novelPromotionData?.fbfResultVideoUrl ?? null
  const persistedChunkResultUrl = projectQuery.data?.novelPromotionData?.chunkResultVideoUrl ?? null
  const invalidateProjectData = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectData(projectId) })
  }
  const userImageModels = userModelsQuery.data?.image || []
  const {
    sourceVideoFile, setSourceVideoFile,
    targetImageFile, setTargetImageFile,
    modelId, setModelId,
    prompt, setPrompt,
    characterHint, setCharacterHint,
    resolution, setResolution,
    artStyle, setArtStyle,
    chunkDuration, setChunkDuration,
    isUploading, setIsUploading, isSplitting, isGenerating, isMerging,
    splitCompleted, splitChunks,
    chunks, resultVideoUrl, setResultVideoUrl, error, setError,
    settingsChanged,
    uploadedVideoUrl, setUploadedVideoUrl,
    uploadedImageUrl, setUploadedImageUrl,
    isBusy: chunkBusy,
    uploadFile, startSplit, startGenerate, startMerge, stopAll: stopChunkAll, retryChunk, reset
  } = useVideoCharacterSwap(projectVideoModel ?? undefined, {
    persistedResultVideoUrl: persistedChunkResultUrl,
    onResultPersisted: invalidateProjectData,
  })

  const fbf = useFrameByFrameFlow(projectId, {
    persistedResultVideoUrl: persistedFbfResultUrl,
    onResultPersisted: invalidateProjectData,
  })

  const [engine, setEngine] = useState<'chunk' | 'fbf'>(initialEngine)
  
  // Frame-by-Frame states — FBF chỉ chạy img2img; V2V dùng engine chunk riêng
  const [targetFps, setTargetFps] = useState<number>(8)
  const [temporalMode, setTemporalMode] = useState<'none' | 'seed_consistency' | 'prev_frame_ref' | 'motion_compensated'>('prev_frame_ref')
  const [fbfModelId, setFbfModelId] = useState<string>('')
  const [fbfArtStyle, setFbfArtStyle] = useState<string>(projectArtStyle || '')
  const [promptPreset, setPromptPreset] = useState<string>('face_swap')
  const [chunkMotionPreset, setChunkMotionPreset] = useState<string>('auto')
  const [customPrompt, setCustomPrompt] = useState<string>('')

  useEffect(() => {
    if (projectArtStyle) setFbfArtStyle(projectArtStyle)
  }, [projectArtStyle])

  const fbfModelOptions = useMemo(() => {
    return userImageModels.length > 0 ? userImageModels : []
  }, [userImageModels])

  useEffect(() => {
    if (fbfModelId) return
    if (projectEditModel) {
      setFbfModelId(projectEditModel)
      return
    }
    const first = fbfModelOptions[0]
    if (first?.value) setFbfModelId(first.value)
  }, [fbfModelId, projectEditModel, fbfModelOptions])

  const fbfDisplayClassifications = useMemo(
    () => normalizeFrameClassifications(fbf.extractedFrames.length, fbf.frameClassifications),
    [fbf.extractedFrames.length, fbf.frameClassifications],
  )

  const fbfStartAiBlockedReason = useMemo(() => {
    if (!fbf.extractCompleted) return 'Cần cắt frame trước'
    if (!fbfModelId) return 'Chọn Edit Image Model (hoặc cấu hình trong project)'
    if (fbf.processableFrameCount === 0) return 'Không có frame SWAP — bấm badge để bật'
    if (fbf.hasActiveFrameJobs) return 'Đang xử lý frame — đợi xong hoặc bấm Stop'
    if (fbf.isGenerating) return 'Đang khởi động AI...'
    if (!customPrompt.trim()) return 'Nhập prompt'
    return null
  }, [fbf.extractCompleted, fbfModelId, fbf.processableFrameCount, fbf.hasActiveFrameJobs, fbf.isGenerating, customPrompt])

  useEffect(() => {
    if (promptPreset === 'custom') return
    setCustomPrompt(getFbfPromptPreset(promptPreset, locale))
  }, [promptPreset, locale])

  const handleExtractFrames = async () => {
    if (!sourceVideoFile && !uploadedVideoUrl) {
      toast.error('Vui lòng tải video gốc lên trước')
      return
    }

    if (fbf.isBusy && !fbf.isExtracting) {
      const ok = window.confirm(
        'Đang có tiến trình chạy. Dừng và cắt lại frame? Kết quả detect/AI hiện tại sẽ bị xóa.',
      )
      if (!ok) return
      await fbf.stopAll()
    }

    fbf.setError('')
    try {
      let vUrl = uploadedVideoUrl
      if (!vUrl && sourceVideoFile) {
        setIsUploading(true)
        vUrl = await uploadFile(sourceVideoFile)
        setUploadedVideoUrl(vUrl)
        setIsUploading(false)
      }

      await fbf.startExtract(vUrl, targetFps)
      toast.success(fbf.extractCompleted ? 'Đang cắt lại frame...' : 'Đang cắt frame từ video...')
    } catch (err: unknown) {
      const e = err as { message?: string }
      fbf.setError(e?.message || 'Lỗi khi cắt frame')
      toast.error(e?.message || 'Lỗi khi cắt frame')
      setIsUploading(false)
    }
  }

  const handleClassifyFrames = async () => {
    if (!fbf.extractCompleted) {
      toast.error('Hãy cắt frame trước')
      return
    }

    if (fbf.hasActiveFrameJobs) {
      toast.error('Đợi xử lý frame xong hoặc bấm Stop trước khi detect lại')
      return
    }

    if (fbf.detectCompleted || fbf.processedFrames.length > 0) {
      const ok = window.confirm(
        'Detect lại sẽ ghi đè badge SWAP/SKIP và xóa kết quả AI hiện tại. Tiếp tục?',
      )
      if (!ok) return
      fbf.resetForReclassify()
    }

    try {
      let iUrl = uploadedImageUrl
      if (!iUrl && targetImageFile) {
        setIsUploading(true)
        iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
        setIsUploading(false)
      }
      await fbf.startClassify({
        characterHint,
        referenceImageUrl: iUrl || undefined,
      })
      toast.success('Đang phân loại frame có nhân vật...')
    } catch (err: unknown) {
      const e = err as { message?: string }
      fbf.setError(e?.message || 'Lỗi phân loại frame')
      toast.error(e?.message || 'Lỗi phân loại frame')
    }
  }

  const handleRetryFbfFrame = async (frameIndex: number) => {
    try {
      let iUrl = uploadedImageUrl
      if (!iUrl && targetImageFile) {
        iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
      }
      await fbf.retryFrame(frameIndex, {
        modelId: fbfModelId,
        prompt: customPrompt,
        referenceImageUrl: iUrl || undefined,
        processingMode: 'img2img',
        artStyle: fbfArtStyle,
        temporalMode,
      })
      toast.success(`Đang tạo lại frame #${frameIndex + 1}`)
    } catch (err: unknown) {
      const e = err as { message?: string }
      toast.error(e?.message || 'Không thể tạo lại frame')
    }
  }

  const handleFbfMerge = async () => {
    try {
      await fbf.mergeVideo()
      toast.success('Đang ghép video...')
    } catch (err: unknown) {
      const e = err as { message?: string }
      toast.error(e?.message || 'Không thể ghép video')
    }
  }

  const handleChunkRemerge = async () => {
    try {
      await startMerge()
      toast.success('Đang ghép lại video...')
    } catch {
      toast.error('Không thể ghép lại video')
    }
  }

  const handleStartFbfGenerate = async () => {
    if (!fbf.extractCompleted) {
      toast.error('Hãy cắt frame trước khi xử lý AI')
      return
    }
    if (fbf.processableFrameCount === 0) {
      toast.error('Không có frame SWAP — bấm badge SWAP trên frame cần thay')
      return
    }
    if (fbf.extractedFrames.length > FBF_MAX_FRAMES) {
      toast.error(`Quá nhiều frame (${fbf.extractedFrames.length}). Tối đa ${FBF_MAX_FRAMES} — giảm FPS hoặc video ngắn hơn.`)
      return
    }
    if (!fbfModelId) {
      toast.error('Vui lòng chọn Edit Image Model')
      return
    }
    if (fbfModelId.includes('imagen-')) {
      toast.error('Imagen chỉ hỗ trợ text-to-image. Hãy chọn Gemini image model (vd. gemini-2.5-flash-image) cho FBF.')
      return
    }
    if (!customPrompt.trim()) {
      toast.error('Vui lòng chọn hoặc nhập prompt')
      return
    }

    try {
      let iUrl = uploadedImageUrl
      if (!iUrl && targetImageFile) {
        setIsUploading(true)
        iUrl = await uploadFile(targetImageFile)
        setUploadedImageUrl(iUrl)
        setIsUploading(false)
      }

      await fbf.startGenerate({
        modelId: fbfModelId,
        prompt: customPrompt,
        referenceImageUrl: iUrl || '',
        characterHint,
        processingMode: 'img2img',
        artStyle: fbfArtStyle,
        temporalMode,
        filterCharacterFrames: true,
      })
      toast.success(`Đã bắt đầu xử lý ${fbf.processableFrameCount} frame có nhân vật`)
    } catch (err: unknown) {
      const e = err as { message?: string }
      fbf.setError(e?.message || 'Lỗi xử lý')
      toast.error(e?.message || 'Lỗi xử lý')
      setIsUploading(false)
    }
  }

  const videoInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  // Memoize blob URLs so they don't change on every render
  const sourceVideoBlobUrl = useMemo(() => {
    if (sourceVideoFile && sourceVideoFile.size > 0) return URL.createObjectURL(sourceVideoFile)
    return null
  }, [sourceVideoFile])

  const targetImageBlobUrl = useMemo(() => {
    if (targetImageFile && targetImageFile.size > 0) return URL.createObjectURL(targetImageFile)
    return null
  }, [targetImageFile])

  const handleVideoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSourceVideoFile(e.target.files[0])
      setUploadedVideoUrl('')
    }
  }

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setTargetImageFile(e.target.files[0])
      setUploadedImageUrl('')
    }
  }

  const getPlayableVideoUrl = (url: string) => resolvePlayableVideoUrl(url, projectId)
  const getPlayableImageUrl = (url: string) => resolvePlayableImageUrl(url, projectId)

  const selectedModelConfig = userVideoModels?.find(m => m.value === modelId)
  const durationOptions = selectedModelConfig?.capabilities?.video?.durationOptions

  const modelOptions = useMemo(() => {
    if (userVideoModels && userVideoModels.length > 0) return userVideoModels
    return [
      { value: 'fal::fal-veo31', label: 'Veo 3.1 (Google)', providerName: 'Google' },
      { value: 'fal::fal-wan25', label: 'Wan 2.5/2.6', providerName: 'Wan' },
      { value: 'fal::fal-ai/kling-video/v3/standard/image-to-video', label: 'Kling V3', providerName: 'Kling' },
    ]
  }, [userVideoModels])

  const allChunksCompleted = chunks.length > 0 && chunks.every(c => c.status === 'completed' && c.resultVideoUrl)

  return (
    <div className="flex flex-col h-full max-w-6xl mx-auto p-6 space-y-6 animate-fade-in pb-20">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('faceSwapTitle')}</h2>
        <p className="text-foreground/70 mt-1">
          Upload a video, preview its chunks, tweak AI settings, and generate a character-swapped video.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Source Video */}
        <GlassSurface className="p-6">
          <label className="text-lg font-semibold mb-4 block">{t('uploadOriginalVideo')}</label>
            <div 
              className={`border-2 border-dashed rounded-lg flex flex-col items-center justify-center p-6 text-center transition-colors relative ${sourceVideoFile ? 'border-primary/50 bg-primary/5 min-h-[12rem]' : 'border-white/20 hover:bg-white/5 h-48 cursor-pointer'}`}
              onClick={() => !sourceVideoFile && videoInputRef.current?.click()}
            >
              {sourceVideoFile ? (
                <div className="w-full h-full flex flex-col items-center">
                  <div className="flex w-full justify-between items-center mb-2">
                    <div className="flex items-center gap-2 max-w-[80%]">
                      <AppIcon name="video" className="w-5 h-5 text-primary flex-shrink-0" />
                      <p className="font-medium truncate text-sm">{sourceVideoFile.name}</p>
                      <p className="text-xs text-foreground/70 flex-shrink-0">({(sourceVideoFile.size / (1024 * 1024)).toFixed(2)} MB)</p>
                    </div>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setSourceVideoFile(null); setUploadedVideoUrl(''); }}
                      className="text-xs bg-black/20 hover:bg-black/40 px-2 py-1 rounded"
                    >
                      Change
                    </button>
                  </div>
                  <video 
                    src={sourceVideoBlobUrl || getPlayableVideoUrl(uploadedVideoUrl)} 
                    controls 
                    className="w-full max-h-[300px] object-contain bg-black/40 rounded shadow-sm"
                  />
                </div>
              ) : (
                <>
                  <AppIcon name="cloudUpload" className="w-12 h-12 text-foreground/50 mb-2" />
                  <p className="text-sm text-foreground/70">Click to upload MP4 video</p>
                </>
              )}
              <input 
                type="file" 
              accept="video/mp4,video/quicktime" 
              className="hidden" 
              ref={videoInputRef}
              onChange={handleVideoChange}
            />
          </div>
        </GlassSurface>

        {/* Target Image */}
        <GlassSurface className="p-6">
          <label className="text-lg font-semibold mb-4 block">{t('targetCharacterImage')}</label>
          <div 
            className={`border-2 border-dashed rounded-lg flex flex-col items-center justify-center p-6 text-center h-48 cursor-pointer transition-colors ${(targetImageFile || uploadedImageUrl) ? 'border-primary/50 bg-primary/5' : 'border-white/20 hover:bg-white/5'}`}
            onClick={() => imageInputRef.current?.click()}
          >
            {(targetImageFile || uploadedImageUrl) ? (
              <>
                <AppIcon name="image" className="w-12 h-12 text-primary mb-2" />
                <p className="font-medium truncate max-w-full px-4">{targetImageFile?.name || 'Saved Image'}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img 
                  src={targetImageBlobUrl || getPlayableImageUrl(uploadedImageUrl)} 
                  alt="Preview" 
                  className="w-16 h-16 object-cover rounded mt-2 shadow-sm"
                />
              </>
            ) : (
              <>
                <AppIcon name="cloudUpload" className="w-12 h-12 text-foreground/50 mb-2" />
                <p className="text-sm text-foreground/70">Click to upload JPG/PNG image</p>
              </>
            )}
            <input 
              type="file" 
              accept="image/*" 
              className="hidden" 
              ref={imageInputRef}
              onChange={handleImageChange}
            />
          </div>
        </GlassSurface>
      </div>

      {/* Engine Switcher */}
      <GlassSurface className="p-4">
        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">Processing Algorithm / Engine</h3>
            <p className="text-xs text-foreground/60">Choose between standard chunk segmentation or high-precision optical flow.</p>
          </div>
          <div className="flex gap-2 p-1 bg-black/40 rounded-lg border border-white/10 w-full md:w-auto">
            <button
              type="button"
              onClick={() => setEngine('chunk')}
              className={`flex-1 md:flex-initial px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                engine === 'chunk'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-foreground/70 hover:text-foreground hover:bg-white/5'
              }`}
            >
              <AppIcon name="video" className="w-4 h-4" />
              <span>Chunk I2V (Nhanh)</span>
            </button>
            <button
              type="button"
              onClick={() => setEngine('fbf')}
              className={`flex-1 md:flex-initial px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                engine === 'fbf'
                  ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-sm font-semibold'
                  : 'text-foreground/70 hover:text-foreground hover:bg-white/5'
              }`}
            >
              <AppIcon name="sparkles" className="w-4 h-4 text-yellow-300" />
              <span>Frame-by-Frame Optical Flow</span>
            </button>
          </div>
        </div>
      </GlassSurface>

      {/* Engine 1: Chunk-based I2V character swap */}
      {engine === 'chunk' && (
        <>
          <GlassSurface className="p-4 border border-amber-500/20 bg-amber-500/5">
            <p className="text-sm text-foreground/80 leading-relaxed">
              <strong className="text-amber-400">Lưu ý:</strong> Engine này không phải V2V thuần — nó phân tích <em>chuyển động</em> từ video gốc, ghép nhân vật lên frame đầu (cần <strong>Edit Model</strong> trong cấu hình project), rồi tạo video mới bằng Image-to-Video.
              {!projectEditModel && (
                <span className="block mt-1 text-amber-400/90">⚠️ Chưa cấu hình Edit Model — hệ thống sẽ dùng ảnh nhân vật thẳng làm frame đầu (dễ bị &quot;đứng yên như ảnh tĩnh&quot;).</span>
              )}
            </p>
          </GlassSurface>
          <GlassSurface className="p-6">
            <h3 className="text-lg font-semibold mb-4">Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Generation Model</label>
                  <ModelCapabilityDropdown
                    models={modelOptions}
                    value={modelId || undefined}
                    onModelChange={(val) => setModelId(val)}
                    capabilityFields={[]}
                    capabilityOverrides={{}}
                    onCapabilityChange={() => {}}
                    placeholder="Select Video Model"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium">Resolution</label>
                    <select 
                      value={resolution} 
                      onChange={(e) => setResolution(e.target.value)}
                      className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                    >
                      {VIDEO_RESOLUTIONS.map(r => (
                        <option key={r.value} value={r.value} className="text-black">{r.label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium">Art Style</label>
                    <select 
                      value={artStyle} 
                      onChange={(e) => setArtStyle(e.target.value)}
                      className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                    >
                      <option value="" className="text-black">No Style Filter</option>
                      {ART_STYLES.map(s => (
                        <option key={s.value} value={s.value} className="text-black">{s.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Character Hint (Optional)</label>
                  <GlassInput 
                    placeholder="Giúp Gemini nhận diện nhân vật cần theo dõi trong video gốc (vd: người ngồi bàn máy tính)..."
                    value={characterHint}
                    onChange={(e) => setCharacterHint(e.target.value)}
                    className="w-full"
                  />
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Motion Prompt</label>
                  <select
                    value={chunkMotionPreset}
                    onChange={(e) => {
                      const value = e.target.value
                      setChunkMotionPreset(value)
                      if (value !== 'custom') {
                        setPrompt(getChunkMotionPromptPreset(value, locale))
                      }
                    }}
                    className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                  >
                    {CHUNK_MOTION_PROMPT_PRESETS.map((p) => (
                      <option key={p.value} value={p.value} className="text-black">
                        {locale === 'en' ? p.labelEn : p.label}
                      </option>
                    ))}
                  </select>
                  <GlassTextarea 
                    placeholder="Để trống + chọn Auto: Gemini phân tích chuyển động từ video gốc. Hoặc mô tả chuyển động/camera (KHÔNG mô tả ngoại hình nhân vật)..."
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value)
                      if (e.target.value.trim() === '') setChunkMotionPreset('auto')
                      else if (chunkMotionPreset !== 'custom') setChunkMotionPreset('custom')
                    }}
                    className="resize-none h-24 w-full"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Chunk Duration (Seconds)</label>
                  {durationOptions && durationOptions.length > 0 ? (
                    <select
                      value={chunkDuration}
                      onChange={(e) => setChunkDuration(Number(e.target.value))}
                      className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                    >
                      {durationOptions.map(opt => (
                        <option key={opt} value={opt} className="bg-background text-foreground">
                          {opt}s
                        </option>
                      ))}
                    </select>
                  ) : (
                    <GlassInput 
                      type="number"
                      min={2}
                      max={15}
                      value={chunkDuration}
                      onChange={(e) => setChunkDuration(Number(e.target.value))}
                      className="w-full"
                    />
                  )}
                  <p className="text-xs text-foreground/50">Change this if you want longer/shorter clips. Requires Re-Split if changed after splitting.</p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3 items-center">
              {settingsChanged && splitCompleted && (
                <span className="text-sm text-yellow-500 font-medium animate-pulse">
                  ⚠️ Settings changed. Review carefully before generating.
                </span>
              )}
              {chunkBusy && (
                <GlassButton
                  variant="secondary"
                  size="lg"
                  onClick={() => { stopChunkAll(); toast.success('Đã dừng các tiến trình') }}
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                >
                  <span className="flex items-center gap-2">
                    <AppIcon name="alert" className="h-4 w-4" />
                    Stop
                  </span>
                </GlassButton>
              )}
              {splitCompleted && (
                <GlassButton 
                  variant="secondary"
                  size="lg" 
                  onClick={startSplit} 
                  disabled={(!sourceVideoFile && !uploadedVideoUrl) || isUploading || isSplitting || isGenerating}
                >
                  Re-Split Video
                </GlassButton>
              )}
              {!splitCompleted ? (
                <GlassButton 
                  variant="primary"
                  size="lg" 
                  onClick={startSplit} 
                  disabled={(!sourceVideoFile && !uploadedVideoUrl) || isUploading || isSplitting}
                  className="w-full md:w-auto min-w-[200px]"
                >
                  {(isUploading || isSplitting) ? (
                    <span className="flex items-center justify-center gap-2">
                      <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                      {isUploading ? 'Uploading...' : 'Splitting...'}
                    </span>
                  ) : (
                    'Split Video'
                  )}
                </GlassButton>
              ) : (
                <GlassButton 
                  variant="primary"
                  size="lg" 
                  onClick={startGenerate} 
                  disabled={(!uploadedImageUrl && !targetImageFile) || isGenerating || chunks.length > 0}
                  className="w-full md:w-auto min-w-[200px]"
                >
                  {isGenerating ? (
                    <span className="flex items-center justify-center gap-2">
                      <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                      Starting AI...
                    </span>
                  ) : (
                    'Generate Character Swap'
                  )}
                </GlassButton>
              )}
            </div>
          </GlassSurface>

          {/* Original Chunks — luôn hiển thị sau khi split để so sánh với AI result */}
          {splitCompleted && splitChunks.length > 0 && (
            <GlassSurface className="p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <AppIcon name="video" className="w-5 h-5 text-primary" />
                {chunks.length > 0 ? `Original Chunks (${splitChunks.length})` : `Review Split Chunks (${splitChunks.length} chunks)`}
              </h3>
              <div className="overflow-x-auto pb-4">
                <div className="flex gap-4 min-w-max">
                  {splitChunks.map((chunk) => (
                    <div key={`split-${chunk.index}`} className="flex flex-col gap-2 w-64">
                      <div className="text-sm font-medium flex justify-between">
                        <span>Chunk {chunk.index + 1}</span>
                        <span className="text-foreground/50">{chunk.duration.toFixed(2)}s</span>
                      </div>
                      <div className="bg-black/40 rounded border border-white/10 aspect-video relative overflow-hidden group">
                        <div className="absolute top-1 left-1 bg-black/60 text-[10px] px-1.5 py-0.5 rounded text-white/80 z-10">Original</div>
                        <video src={getPlayableVideoUrl(chunk.originalUrl)} className="w-full h-full object-cover" controls preload="metadata" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </GlassSurface>
          )}

          {/* Phase 2 Results: Chunks Generation & Merge */}
          {chunks.length > 0 && (
            <GlassSurface className="p-6">
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <AppIcon name="video" className="w-5 h-5 text-primary" />
                    {allChunksCompleted ? 'All chunks generated successfully' : 'Processing AI Generation'}
                  </h3>
                  
                  <GlassButton 
                    variant="primary" 
                    disabled={!allChunksCompleted || isMerging}
                    onClick={handleChunkRemerge}
                  >
                    {isMerging ? (
                      <span className="flex items-center gap-2">
                        <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                        Merging...
                      </span>
                    ) : (resultVideoUrl ? 'Ghép lại video' : 'Merge Final Video')}
                  </GlassButton>
                </div>

                <div className="overflow-x-auto pb-4">
                  <div className="flex gap-4 min-w-max">
                    {[...chunks].sort((a, b) => a.index - b.index).map((chunk) => (
                      <div key={chunk.taskId} className="flex flex-col gap-2 w-64">
                        <div className="text-sm font-medium flex justify-between">
                          <span>Chunk {chunk.index + 1}</span>
                          <span className="text-foreground/50">{chunk.duration.toFixed(2)}s</span>
                        </div>
                        
                        {/* Generated Chunk */}
                        <div className="bg-black/40 rounded border border-white/10 aspect-video relative flex flex-col items-center justify-center overflow-hidden">
                          <div className="absolute top-1 left-1 bg-black/60 text-[10px] px-1.5 py-0.5 rounded text-white/80 z-10">AI Result</div>
                          
                          {chunk.resultVideoUrl ? (
                            <>
                              <video src={getPlayableVideoUrl(chunk.resultVideoUrl)} className="w-full h-full object-cover" controls preload="metadata" autoPlay loop muted />
                              <div className="absolute bottom-2 right-2 z-10">
                                <GlassButton
                                  variant="secondary"
                                  size="sm"
                                  disabled={chunk.status === 'queued' || chunk.status === 'processing'}
                                  onClick={() => retryChunk(chunk.index, chunk.originalUrl, chunk.duration)}
                                >
                                  Tạo lại
                                </GlassButton>
                              </div>
                            </>
                          ) : (chunk.status === 'failed' || chunk.status === 'canceled') ? (
                            <div className="text-red-400 text-sm flex flex-col items-center gap-2 p-2 text-center">
                              <AppIcon name="alert" className="w-6 h-6" />
                              <span className="text-xs line-clamp-2">{chunk.error || 'Failed'}</span>
                              <GlassButton 
                                variant="secondary" 
                                size="sm" 
                                className="mt-1"
                                onClick={() => retryChunk(chunk.index, chunk.originalUrl, chunk.duration)}
                              >
                                Retry
                              </GlassButton>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-2">
                              <AppIcon name="refresh" className="w-6 h-6 animate-spin text-primary/70" />
                              <div className="text-xs text-foreground/60">{chunk.progress}%</div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </GlassSurface>
          )}
        </>
      )}

      {/* Engine 2: Frame-by-Frame Optical Flow */}
      {engine === 'fbf' && (
        <>
          <GlassSurface className="p-6 space-y-6">
            <div className="flex justify-between items-center border-b border-white/10 pb-4">
              <div>
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <AppIcon name="sparkles" className="w-5 h-5 text-purple-400" />
                  Frame-by-Frame Settings
                </h3>
                <p className="text-xs text-foreground/60 mt-1">
                  Bước 1: Cắt frame. Bước 2: Detect nhân vật. Bước 3: Xử lý AI. Bước 4: Ghép video.
                </p>
              </div>
              <span className="text-xs font-semibold px-2.5 py-1 bg-purple-500/20 text-purple-300 rounded-full border border-purple-500/30">
                {!fbf.extractCompleted
                  ? 'Phase 1/4'
                  : fbf.processedFrames.length === 0
                    ? 'Phase 2/4'
                    : !fbf.allFramesCompleted
                      ? 'Phase 3/4'
                      : 'Phase 4/4'}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Edit Image Model (from Settings)</label>
                  <ModelCapabilityDropdown
                    models={fbfModelOptions}
                    value={fbfModelId || undefined}
                    onModelChange={(val) => setFbfModelId(val)}
                    capabilityFields={[]}
                    capabilityOverrides={{}}
                    onCapabilityChange={() => {}}
                    placeholder="Select Edit Model"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium flex justify-between">
                    <span>Target FPS</span>
                    <span className="text-primary font-bold">{targetFps} FPS</span>
                  </label>
                  <input 
                    type="range"
                    min={1} 
                    max={8} 
                    step={1} 
                    value={targetFps} 
                    onChange={(e) => setTargetFps(parseInt(e.target.value))}
                    disabled={fbf.isExtracting}
                    className="w-full accent-primary cursor-pointer disabled:opacity-50"
                  />
                  {fbf.extractCompleted && (
                    <p className="text-xs text-foreground/50">
                      Đổi FPS cần bấm &quot;Cắt lại frame&quot; để áp dụng. Tối đa ~{FBF_MAX_FRAMES} frame/lần.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium">Art Style (from Settings)</label>
                  <select
                    value={fbfArtStyle}
                    onChange={(e) => setFbfArtStyle(e.target.value)}
                    className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                  >
                    <option value="" className="text-black">No Style Filter</option>
                    {ART_STYLES.map((s) => (
                      <option key={s.value} value={s.value} className="text-black">
                        {locale === 'en' ? s.labelEn : s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Temporal Consistency Mode</label>
                  <select 
                    value={temporalMode} 
                    onChange={(e) => setTemporalMode(e.target.value as typeof temporalMode)}
                    disabled={fbf.isGenerating || fbf.hasActiveFrameJobs}
                    className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
                  >
                    <option value="prev_frame_ref" className="text-black">Previous Frame Reference (Recommended)</option>
                    <option value="motion_compensated" className="text-black">Motion Compensated (RAFT)</option>
                    <option value="seed_consistency" className="text-black">Seed Consistency Lock</option>
                    <option value="none" className="text-black">None (Parallel)</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium">Character Hint (for frame detection)</label>
                  <GlassInput
                    placeholder="vd: người ngồi trước màn hình, nhân vật chính..."
                    value={characterHint}
                    onChange={(e) => setCharacterHint(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium">Prompt Preset</label>
                  <select
                    value={promptPreset}
                    onChange={(e) => setPromptPreset(e.target.value)}
                    className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50"
                  >
                    {FBF_CHARACTER_SWAP_PROMPTS.map((preset) => (
                      <option key={preset.value} value={preset.value} className="text-black">
                        {locale === 'en' ? preset.labelEn : preset.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium">AI Prompt</label>
                  <textarea 
                    value={customPrompt} 
                    onChange={(e) => {
                      setCustomPrompt(e.target.value)
                      setPromptPreset('custom')
                    }}
                    placeholder="Chọn preset hoặc nhập prompt tùy chỉnh..."
                    className="w-full bg-white/5 border border-white/20 rounded-md p-2.5 text-sm text-foreground outline-none focus:border-primary/50 h-24 resize-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end items-center gap-4 pt-4 border-t border-white/10">
              {fbf.isExtracting && (
                <div className="flex-1 flex items-center gap-3">
                  <div className="w-full bg-black/40 rounded-full h-2.5 overflow-hidden border border-white/10">
                    <div className="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-300" style={{ width: `${fbf.extractProgress}%` }} />
                  </div>
                  <span className="text-xs font-mono whitespace-nowrap">Extracting ({fbf.extractProgress}%)</span>
                </div>
              )}

              {fbf.isBusy && (
                <GlassButton
                  variant="secondary"
                  size="lg"
                  onClick={() => { fbf.stopAll(); toast.success('Đã dừng các tiến trình') }}
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                >
                  <span className="flex items-center gap-2">
                    <AppIcon name="alert" className="h-4 w-4" />
                    Stop
                  </span>
                </GlassButton>
              )}

              <div className="flex flex-col items-end gap-2">
                <div className="flex flex-wrap gap-3 justify-end">
                  <GlassButton
                  variant={fbf.extractCompleted ? 'secondary' : 'primary'}
                  size="lg"
                  onClick={handleExtractFrames}
                  disabled={(!sourceVideoFile && !uploadedVideoUrl) || isUploading || fbf.isExtracting}
                  className="min-w-[180px]"
                >
                  {(isUploading || fbf.isExtracting) ? (
                    <span className="flex items-center justify-center gap-2">
                      <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                      {isUploading ? 'Uploading...' : fbf.extractCompleted ? 'Cắt lại...' : 'Extracting...'}
                    </span>
                  ) : (
                    fbf.extractCompleted ? 'Cắt lại frame' : 'Extract Frames'
                  )}
                </GlassButton>

                {fbf.extractCompleted && (
                  <GlassButton
                    variant="secondary"
                    size="lg"
                    onClick={handleClassifyFrames}
                    disabled={fbf.isClassifying || fbf.hasActiveFrameJobs}
                    className="min-w-[180px]"
                  >
                    {fbf.isClassifying ? (
                      <span className="flex items-center justify-center gap-2">
                        <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                        Detecting...
                      </span>
                    ) : (
                      fbf.detectCompleted ? 'Detect lại' : 'Detect Character (tùy chọn)'
                    )}
                  </GlassButton>
                )}

                {fbf.extractCompleted && (
                  <GlassButton
                    variant="primary"
                    size="lg"
                    onClick={handleStartFbfGenerate}
                    disabled={
                      !fbfModelId
                      || !fbf.canStartAi
                      || isUploading
                      || !customPrompt.trim()
                    }
                    className="min-w-[220px] bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-semibold"
                  >
                    {(isUploading || fbf.isGenerating) ? (
                      <span className="flex items-center justify-center gap-2">
                        <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                        Starting AI...
                      </span>
                    ) : (
                      `Start AI (${fbf.processableFrameCount} frames)`
                    )}
                  </GlassButton>
                )}

                {fbf.processedFrames.length > 0 && (
                  <GlassButton
                    variant="primary"
                    size="lg"
                    onClick={handleFbfMerge}
                    disabled={!fbf.canMerge}
                    className="min-w-[200px] bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold disabled:opacity-40"
                  >
                    {fbf.isMerging ? (
                      <span className="flex items-center justify-center gap-2">
                        <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                        Đang ghép...
                      </span>
                    ) : (
                      fbf.resultVideoUrl ? 'Ghép lại video' : 'Ghép video (Bước 4)'
                    )}
                  </GlassButton>
                )}
                </div>
                {fbfStartAiBlockedReason && !fbf.isGenerating && !isUploading && (
                  <p className="text-xs text-yellow-500/90 text-right">
                    {fbfStartAiBlockedReason}
                  </p>
                )}
                {fbf.extractCompleted && fbf.processableFrameCount === 0 && (
                  <p className="text-xs text-yellow-500/90 text-right">
                    Tất cả frame đang SKIP — bấm badge SWAP/SKIP trên từng frame.
                  </p>
                )}
                {fbf.extractCompleted && fbf.processedFrames.length > 0 && !fbf.allFramesCompleted && (
                  <p className="text-xs text-foreground/50 text-right">
                    Đang xử lý AI — có thể &quot;Tạo lại&quot; từng frame khi xong.
                  </p>
                )}
                {fbf.allFramesCompleted && !fbf.isMerging && !fbf.resultVideoUrl && (
                  <p className="text-xs text-emerald-500/90 text-right">
                    AI xong — bấm &quot;Ghép video (Bước 4)&quot; để tạo video cuối.
                  </p>
                )}
              </div>
            </div>
          </GlassSurface>

          {fbf.extractCompleted && fbf.extractedFrames.length > 0 && (
            <GlassSurface className="p-6">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <AppIcon name="image" className="w-5 h-5 text-primary" />
                {fbf.processedFrames.length > 0
                  ? `Original Frames (${fbf.extractedFrames.length})`
                  : `Preview Extracted Frames (${fbf.extractedFrames.length} frames @ ${targetFps} FPS)`}
              </h3>
              {fbf.extractCompleted && fbf.processedFrames.length === 0 && (
                <p className="text-xs text-foreground/50 mb-3">
                  Mặc định tất cả frame là SWAP. Bấm badge để đổi SKIP trước khi Start AI. Detect là tùy chọn.
                </p>
              )}
              <div className="overflow-x-auto pb-4">
                <div className="flex gap-3 min-w-max">
                  {fbf.extractedFrames.map((frame) => {
                    const classification = fbfDisplayClassifications.find((c) => c.index === frame.index)
                    return (
                    <div key={`orig-${frame.index}`} className="flex flex-col gap-2 w-28">
                      <div className="text-xs font-medium text-foreground/70 flex items-center justify-between gap-1">
                        <span>#{frame.index + 1}</span>
                        {classification ? (
                          <button
                            type="button"
                            title={classification.reason || 'Bấm để đổi SWAP/SKIP'}
                            onClick={() => fbf.toggleFrameClassification(frame.index)}
                            className={`text-[9px] px-1 rounded cursor-pointer hover:opacity-80 ${classification.hasCharacter ? 'bg-green-500/30 text-green-300' : 'bg-white/10 text-foreground/50'}`}
                          >
                            {classification.hasCharacter ? 'SWAP' : 'SKIP'}
                          </button>
                        ) : null}
                      </div>
                      <div className="bg-black/40 rounded border border-white/10 aspect-[9/16] overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={getPlayableImageUrl(frame.url)} alt={`Frame ${frame.index + 1}`} className="w-full h-full object-cover" />
                      </div>
                    </div>
                  )})}
                </div>
              </div>
            </GlassSurface>
          )}

          {fbf.processedFrames.length > 0 && (
            <GlassSurface className="p-6">
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <AppIcon name="sparkles" className="w-5 h-5 text-primary" />
                    {fbf.allFramesCompleted
                      ? 'Tất cả frame đã xử lý — bấm Ghép video (Bước 4)'
                      : 'Processing AI frames'}
                  </h3>
                  {fbf.isMerging && (
                    <span className="flex items-center gap-2 text-sm text-foreground/70">
                      <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                      Merging...
                    </span>
                  )}
                </div>

                <div className="overflow-x-auto pb-4">
                  <div className="flex gap-3 min-w-max">
                    {fbf.processedFrames.map((frame) => (
                      <div key={frame.taskId || frame.index} className="flex flex-col gap-2 w-28">
                        <div className="text-xs font-medium text-foreground/70 flex justify-between items-center gap-1">
                          <span>#{frame.index + 1} · AI</span>
                          {(frame.status === 'completed' || frame.status === 'failed' || frame.status === 'canceled') && (
                            <button
                              type="button"
                              className="text-[9px] text-primary hover:underline disabled:opacity-40"
                              onClick={() => handleRetryFbfFrame(frame.index)}
                            >
                              Tạo lại
                            </button>
                          )}
                        </div>
                        <div className="bg-black/40 rounded border border-white/10 aspect-[9/16] relative overflow-hidden">
                          {frame.resultUrl ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={getPlayableImageUrl(frame.resultUrl)} alt={`Result ${frame.index + 1}`} className="w-full h-full object-cover" />
                          ) : (frame.status === 'failed' || frame.status === 'canceled') ? (
                            <div className="w-full h-full flex flex-col items-center justify-center text-red-400 text-xs p-1 text-center gap-1">
                              <span className="line-clamp-2">{frame.error || 'Failed'}</span>
                            </div>
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                              <AppIcon name="refresh" className="w-4 h-4 animate-spin text-primary/70" />
                              <span className="text-[10px] text-foreground/60">{frame.progress || 0}%</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </GlassSurface>
          )}
        </>
      )}

      {/* Backend Live SSE Logs */}
      <BackendLogViewer projectId={projectId} className="my-6" />

      {/* Final Result / Error */}
      {error && !chunks.length && !fbf.processedFrames.length && (
        <GlassSurface className="p-6 bg-red-500/10 border-red-500/30">
          <div className="text-red-400 p-2 flex items-start gap-3">
            <AppIcon name="alert" className="w-5 h-5 mt-0.5 shrink-0" />
            <p>{error || fbf.error}</p>
          </div>
        </GlassSurface>
      )}

      {fbf.error && (
        <GlassSurface className="p-6 bg-red-500/10 border-red-500/30">
          <div className="text-red-400 p-2 flex items-start gap-3">
            <AppIcon name="alert" className="w-5 h-5 mt-0.5 shrink-0" />
            <p>{fbf.error}</p>
          </div>
        </GlassSurface>
      )}

      {(() => {
        // Chỉ hiển thị kết quả của engine đang chọn — tránh video cũ của engine kia đè lên
        const activeResultUrl = engine === 'fbf' ? fbf.resultVideoUrl : resultVideoUrl
        if (!activeResultUrl) return null
        return (
        <GlassSurface className="p-6">
          <div className="space-y-4">
             <h3 className="text-lg font-semibold">Final Merged Video</h3>
             <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto">
                {(sourceVideoBlobUrl || uploadedVideoUrl) && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-foreground/70 text-center">Original</div>
                    <div className="aspect-video bg-black/50 rounded-lg overflow-hidden border border-white/10">
                      <video
                        src={sourceVideoBlobUrl || getPlayableVideoUrl(uploadedVideoUrl)}
                        controls
                        className="w-full h-full object-contain"
                        loop
                        muted
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <div className="text-sm font-medium text-primary text-center">AI Result</div>
                  <div className="aspect-video bg-black/50 rounded-lg overflow-hidden border border-primary/30">
                    <video
                      src={getPlayableVideoUrl(activeResultUrl)}
                      controls
                      className="w-full h-full object-contain"
                      autoPlay
                      loop
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-4 justify-center">
                <GlassButton
                  variant="secondary"
                  onClick={async () => {
                    await reset()
                    await fbf.resetFbf()
                    invalidateProjectData()
                  }}
                >
                  {t('startNew')}
                </GlassButton>
                <a href={getPlayableVideoUrl(activeResultUrl)} target="_blank" rel="noreferrer" download className="block">
                   <GlassButton variant="primary">{t('downloadResult')}</GlassButton>
                </a>
              </div>
          </div>
        </GlassSurface>
        )
      })()}
    </div>
  )
}
