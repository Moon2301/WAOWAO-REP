import { toDisplayImageUrl } from '@/lib/media/image-url'

const STORAGE_KEY_PREFIXES = ['images/', 'video/', 'voice/', 'projects/'] as const
const STORAGE_SIGN_PATH = '/api/storage/sign'

function isStorageKey(value: string): boolean {
  const normalized = value.replace(/^\/+/, '')
  return STORAGE_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function extractKeyFromStorageSignRoute(input: string): string | null {
  if (!/(?:^|\/)api\/storage\/sign(?:\?|$)/.test(input)) return null
  try {
    const parsed = new URL(input, 'http://localhost')
    if (!parsed.pathname.endsWith(STORAGE_SIGN_PATH)) return null
    const key = parsed.searchParams.get('key')
    if (!key) return null
    return decodeURIComponent(key).replace(/^\/+/, '')
  } catch {
    return null
  }
}

function resolveStorageKey(value: string): string | null {
  const signKey = extractKeyFromStorageSignRoute(value)
  if (signKey) return signKey
  if (value.startsWith('/api/files/')) {
    return decodeURIComponent(value.replace('/api/files/', '')).replace(/^\/+/, '')
  }
  if (isStorageKey(value)) return value.replace(/^\/+/, '')
  return null
}

export function resolvePlayableVideoUrl(url: string, projectId: string): string {
  if (!url) return url
  if (
    url.startsWith('blob:')
    || url.startsWith('http://')
    || url.startsWith('https://')
    || url.startsWith('/m/')
    || url.startsWith('/api/files/')
  ) {
    return url
  }

  const storageKey = resolveStorageKey(url)
  if (storageKey) {
    return `/api/novel-promotion/${projectId}/video-proxy?key=${encodeURIComponent(storageKey)}`
  }

  if (url.startsWith('/api/novel-promotion/') && url.includes('video-proxy')) {
    return url
  }

  const normalized = url.replace(/^\/+/, '')
  return `/api/novel-promotion/${projectId}/video-proxy?key=${encodeURIComponent(normalized)}`
}

export function resolvePlayableImageUrl(url: string, projectId: string): string {
  if (!url) return url
  if (
    url.startsWith('blob:')
    || url.startsWith('http://')
    || url.startsWith('https://')
    || url.startsWith('/m/')
    || url.startsWith('/api/files/')
  ) {
    return url
  }

  const displayUrl = toDisplayImageUrl(url)
  if (displayUrl) return displayUrl

  const storageKey = resolveStorageKey(url)
  if (storageKey) {
    return `/api/storage/sign?key=${encodeURIComponent(storageKey)}`
  }

  return resolvePlayableVideoUrl(url, projectId)
}
