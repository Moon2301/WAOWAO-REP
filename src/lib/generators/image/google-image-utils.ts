import { getInternalBaseUrl } from '@/lib/env'
import { getImageBase64Cached } from '@/lib/image-cache'
import { logWarn as _ulogWarn } from '@/lib/logging/core'
import type { Image } from '@google/genai'

/**
 * Resolve a URL / data URL / base64 string into Google GenAI Image bytes.
 */
export async function resolveGoogleApiImage(imageData: string): Promise<Image> {
  if (imageData.startsWith('data:')) {
    const base64Start = imageData.indexOf(';base64,')
    if (base64Start === -1) {
      throw new Error('GOOGLE_IMAGE_INVALID: data URL missing base64 payload')
    }
    return {
      mimeType: imageData.substring(5, base64Start),
      imageBytes: imageData.substring(base64Start + 8),
    }
  }

  if (imageData.startsWith('http') || imageData.startsWith('/')) {
    let fullUrl = imageData
    if (imageData.startsWith('/')) {
      fullUrl = `${getInternalBaseUrl()}${imageData}`
    }
    const base64DataUrl = await getImageBase64Cached(fullUrl)
    const base64Start = base64DataUrl.indexOf(';base64,')
    if (base64Start === -1) {
      throw new Error('GOOGLE_IMAGE_INVALID: failed to resolve reference image URL')
    }
    return {
      mimeType: base64DataUrl.substring(5, base64Start),
      imageBytes: base64DataUrl.substring(base64Start + 8),
    }
  }

  return {
    mimeType: 'image/png',
    imageBytes: imageData,
  }
}

export async function resolveGoogleApiImages(
  referenceImages: string[],
  maxCount = 14,
): Promise<Image[]> {
  const images: Image[] = []
  for (let i = 0; i < Math.min(referenceImages.length, maxCount); i++) {
    try {
      images.push(await resolveGoogleApiImage(referenceImages[i]))
    } catch (error) {
      _ulogWarn(`Failed to resolve Google reference image ${i + 1}:`, error)
    }
  }
  return images
}
