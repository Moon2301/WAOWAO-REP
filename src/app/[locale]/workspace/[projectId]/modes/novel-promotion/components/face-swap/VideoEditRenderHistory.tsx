'use client'

import { resolvePlayableVideoUrl } from '@/lib/media/playable-url'
import type { VideoEditEngine, VideoEditRenderRecord } from '@/lib/video-edit/persistence'
import GlassButton from '@/components/ui/primitives/GlassButton'
import GlassSurface from '@/components/ui/primitives/GlassSurface'
import { AppIcon } from '@/components/ui/icons'
import { useVideoEditRenderActions, useVideoEditRenders } from './useVideoEditPersistence'

type VideoEditRenderHistoryProps = {
  projectId: string
  engine: VideoEditEngine
  engineLabel: string
}

function formatRenderTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function VideoEditRenderHistory({ projectId, engine, engineLabel }: VideoEditRenderHistoryProps) {
  const { data: renders = [], isLoading } = useVideoEditRenders(projectId, engine)
  const { deleteRender } = useVideoEditRenderActions(projectId, engine)

  if (isLoading) {
    return (
      <GlassSurface className="p-4">
        <p className="text-sm text-foreground/50">Đang tải lịch sử render...</p>
      </GlassSurface>
    )
  }

  if (renders.length === 0) {
    return (
      <GlassSurface className="p-4">
        <h3 className="text-sm font-semibold text-foreground/70">Lịch sử render ({engineLabel})</h3>
        <p className="text-xs text-foreground/50 mt-2">Chưa có video nào — mỗi lần ghép xong sẽ lưu ở đây.</p>
      </GlassSurface>
    )
  }

  return (
    <GlassSurface className="p-6">
      <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <AppIcon name="video" className="w-5 h-5 text-primary" />
        Lịch sử render ({engineLabel})
      </h3>
      <p className="text-xs text-foreground/50 mb-4">
        Mỗi lần ghép video thành công được lưu riêng. Kéo xuống và xóa bản không cần.
      </p>
      <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
        {renders.map((render: VideoEditRenderRecord, index) => (
          <div
            key={render.id}
            className="rounded-lg border border-white/10 bg-black/20 p-3 flex flex-col sm:flex-row gap-3"
          >
            <div className="sm:w-48 shrink-0">
              <div className="aspect-video bg-black/50 rounded overflow-hidden border border-white/10">
                <video
                  src={resolvePlayableVideoUrl(render.videoUrl, projectId)}
                  className="w-full h-full object-contain"
                  controls
                  preload="metadata"
                />
              </div>
            </div>
            <div className="flex-1 min-w-0 flex flex-col justify-between gap-2">
              <div>
                <p className="text-sm font-medium">
                  Lần {renders.length - index}
                  {index === 0 ? ' · Mới nhất' : ''}
                </p>
                <p className="text-xs text-foreground/50">{formatRenderTime(render.createdAt)}</p>
                {render.meta?.totalFrames != null && (
                  <p className="text-xs text-foreground/50 mt-1">
                    {String(render.meta.totalFrames)} frames
                    {render.meta.targetFps != null ? ` @ ${render.meta.targetFps} FPS` : ''}
                  </p>
                )}
                {render.meta?.chunkCount != null && (
                  <p className="text-xs text-foreground/50 mt-1">
                    {String(render.meta.chunkCount)} chunks
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={resolvePlayableVideoUrl(render.videoUrl, projectId)}
                  target="_blank"
                  rel="noreferrer"
                  download
                  className="inline-block"
                >
                  <GlassButton variant="secondary" size="sm">Tải về</GlassButton>
                </a>
                <GlassButton
                  variant="secondary"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  onClick={async () => {
                    if (!window.confirm('Xóa bản render này khỏi lịch sử?')) return
                    try {
                      await deleteRender(render.id)
                    } catch {
                      // toast handled by parent if needed
                    }
                  }}
                >
                  Xóa
                </GlassButton>
              </div>
            </div>
          </div>
        ))}
      </div>
    </GlassSurface>
  )
}
