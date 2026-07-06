import { GoogleGenAI } from '@google/genai'
import { getProviderConfig, getUserModels, getProviderKey } from '@/lib/api-config'
import { createScopedLogger } from '@/lib/logging/core'
import { resolveGoogleApiImage } from '@/lib/generators/image/google-image-utils'

const logger = createScopedLogger({ module: 'llm.frame-character-detect' })

export interface FrameCharacterDetectResult {
  hasCharacter: boolean
  reason?: string
}

function parseDetectJson(text: string): FrameCharacterDetectResult {
  const trimmed = text.trim()
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { hasCharacter: trimmed.toLowerCase().includes('true'), reason: trimmed.slice(0, 200) }
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { hasCharacter?: boolean; reason?: string }
    return {
      hasCharacter: parsed.hasCharacter === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    }
  } catch {
    return { hasCharacter: false, reason: 'Failed to parse detection response' }
  }
}

/**
 * Kiểm tra frame có chứa nhân vật cần thay (hoặc người khớp mô tả) hay không.
 */
export async function detectCharacterInFrame(
  imageUrl: string,
  userId: string,
  options?: {
    characterHint?: string
    referenceImageUrl?: string
  },
): Promise<FrameCharacterDetectResult> {
  const models = await getUserModels(userId)
  const googleModels = models.filter(
    (m) => m.type === 'llm'
      && (getProviderKey(m.provider).toLowerCase() === 'google'
        || getProviderKey(m.provider).toLowerCase() === 'gemini-compatible'),
  )
  if (googleModels.length === 0) {
    throw new Error('Cần cấu hình Google Gemini (LLM) để phân loại frame.')
  }

  const selection = googleModels[0]
  const { apiKey } = await getProviderConfig(userId, selection.provider)
  if (!apiKey) {
    throw new Error('Google API Key is required for frame classification.')
  }

  const hint = options?.characterHint?.trim()
    || 'the main human subject that should be replaced in a character-swap workflow'

  const prompt = `You are a frame classifier for video character replacement.
Analyze the provided frame image and decide if it contains a visible person/subject that matches:
"${hint}"

${options?.referenceImageUrl ? 'A second reference image shows the TARGET character identity to swap in. The frame should be processed only if the original frame contains a person in a similar role (visible body/face), not empty scenery only.' : ''}

Reply with JSON only:
{"hasCharacter": true or false, "reason": "one short sentence"}

Rules:
- hasCharacter=false for empty scenery, objects-only, extreme close-ups with no person, or shots where the target subject is fully off-screen
- hasCharacter=true when a person matching the hint is clearly visible and worth running character swap on`

  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = []

  const frameImage = await resolveGoogleApiImage(imageUrl)
  parts.push({
    inlineData: {
      mimeType: frameImage.mimeType || 'image/jpeg',
      data: frameImage.imageBytes || '',
    },
  })

  if (options?.referenceImageUrl) {
    const refImage = await resolveGoogleApiImage(options.referenceImageUrl)
    parts.push({
      inlineData: {
        mimeType: refImage.mimeType || 'image/jpeg',
        data: refImage.imageBytes || '',
      },
    })
  }

  parts.push({ text: prompt })

  const ai = new GoogleGenAI({ apiKey })
  const response = await ai.models.generateContent({
    model: selection.modelId,
    contents: [{ role: 'user', parts }],
  })

  const text = response.text || ''
  const result = parseDetectJson(text)
  logger.info({
    action: 'frame_character_detect',
    details: { hasCharacter: result.hasCharacter, reason: result.reason },
  })
  return result
}
