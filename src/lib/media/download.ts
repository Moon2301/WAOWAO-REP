import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import { extractStorageKey, getObjectBuffer, toFetchableUrl } from '@/lib/storage'

export async function resolveCanonicalStorageKey(value: string): Promise<string | null> {
  if (!value?.trim()) return null
  return await resolveStorageKeyFromMediaValue(value) || extractStorageKey(value)
}

export async function downloadMediaValueToBuffer(
  value: string,
  requestHeaders?: Record<string, string>,
): Promise<Buffer> {
  if (!value?.trim()) {
    throw new Error('Thiếu media value để tải xuống')
  }

  // Task cũ có thể còn chứa data: base64 trong payload — decode trực tiếp.
  if (value.startsWith('data:')) {
    const base64Start = value.indexOf(';base64,')
    if (base64Start === -1) {
      throw new Error('data: URL không hợp lệ (thiếu base64)')
    }
    return Buffer.from(value.substring(base64Start + 8), 'base64')
  }

  const storageKey = await resolveCanonicalStorageKey(value)
  if (storageKey) {
    try {
      return await getObjectBuffer(storageKey)
    } catch {
      // Fall through to HTTP fetch for signed routes / legacy refs.
    }
  }

  const shouldFetch =
    value.startsWith('http://')
    || value.startsWith('https://')
    || value.startsWith('/api/storage/sign')
    || value.startsWith('api/storage/sign')
    || value.startsWith('/api/files/')
    || value.startsWith('/m/')
    || value.startsWith('/images/')
    || value.startsWith('/api/novel-promotion/')

  if (shouldFetch) {
    const fetchUrl = toFetchableUrl(value.startsWith('api/storage/sign') ? `/${value}` : value)
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MediaDownloader/1.0)',
        ...(requestHeaders || {}),
      },
    })
    if (!response.ok) {
      throw new Error(`Failed to download media (${response.status}): ${value.substring(0, 120)}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  if (storageKey) {
    return await getObjectBuffer(storageKey)
  }

  throw new Error(`Không thể resolve storage key cho media value: ${value.substring(0, 120)}`)
}
