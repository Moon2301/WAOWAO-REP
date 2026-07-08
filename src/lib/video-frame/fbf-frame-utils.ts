export type FbfFrameNamingOptions = {
  prefix: string
  suffix: string
  /** Số thứ tự của frame index 0 (thường là 1 → frame_0001) */
  startIndex: number
  padDigits: number
}

export const DEFAULT_FBF_FRAME_NAMING: FbfFrameNamingOptions = {
  prefix: 'frame_',
  suffix: '',
  startIndex: 1,
  padDigits: 4,
}

export function formatFbfFrameFilename(
  frameIndex: number,
  options: FbfFrameNamingOptions,
  ext = 'jpg',
): string {
  const seq = String(options.startIndex + frameIndex).padStart(options.padDigits, '0')
  const base = `${options.prefix}${seq}${options.suffix}`
  return ext ? `${base}.${ext.replace(/^\./, '')}` : base
}

export async function downloadFbfFramesZip(params: {
  frames: Array<{ index: number; url: string }>
  naming: FbfFrameNamingOptions
  zipFilename: string
  resolveUrl: (url: string) => string
}): Promise<{ downloaded: number; skipped: number }> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  let downloaded = 0
  let skipped = 0

  for (const frame of params.frames) {
    if (!frame.url) {
      skipped += 1
      continue
    }
    try {
      const res = await fetch(params.resolveUrl(frame.url))
      if (!res.ok) {
        skipped += 1
        continue
      }
      const blob = await res.blob()
      const ext = blob.type.includes('png')
        ? 'png'
        : blob.type.includes('webp')
          ? 'webp'
          : 'jpg'
      zip.file(formatFbfFrameFilename(frame.index, params.naming, ext), blob)
      downloaded += 1
    } catch {
      skipped += 1
    }
  }

  if (downloaded === 0) {
    throw new Error('Không tải được frame nào')
  }

  const content = await zip.generateAsync({ type: 'blob' })
  const link = document.createElement('a')
  const objectUrl = URL.createObjectURL(content)
  link.href = objectUrl
  link.download = params.zipFilename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)

  return { downloaded, skipped }
}
