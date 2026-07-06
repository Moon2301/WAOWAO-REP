import { GoogleGenAI } from '@google/genai'
import { getProviderConfig, getUserModels, getProviderKey } from '@/lib/api-config'
import { createScopedLogger } from '@/lib/logging/core'
import { buildVideoAnalyzePrompt } from '@/lib/video-character-swap/prompts'

const logger = createScopedLogger({ module: 'llm.video-analyze' })

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Uploads a video to Google AI Studio and uses Gemini to extract
 * a highly detailed action/motion prompt.
 */
export async function analyzeVideoToPrompt(
  videoPath: string,
  userId: string,
  characterHint?: string,
  promptText = buildVideoAnalyzePrompt(characterHint),
): Promise<string> {
  logger.info({ action: 'video_analyze_start', details: { videoPath } })

  const models = await getUserModels(userId)
  const googleModels = models.filter(m => m.type === 'llm' && (getProviderKey(m.provider).toLowerCase() === 'google' || getProviderKey(m.provider).toLowerCase() === 'gemini-compatible'))

  if (googleModels.length === 0) {
    throw new Error('SENSITIVE_CONTENT: Vui lòng cấu hình ít nhất một mô hình Google Gemini để phân tích video.')
  }

  const selection = googleModels[0]
  const { apiKey } = await getProviderConfig(userId, selection.provider)
  if (!apiKey) {
    throw new Error('Google API Key is required for video analysis.')
  }

  const ai = new GoogleGenAI({ apiKey })

  try {
    // 1. Upload file
    logger.info({ action: 'video_analyze_uploading', details: { videoPath } })
    const uploadResult = await ai.files.upload({ file: videoPath, config: { mimeType: 'video/mp4' } })
    logger.info({ action: 'video_analyze_uploaded', details: { name: uploadResult.name } })

    if (!uploadResult.name) throw new Error('Failed to get file name from Gemini API')
    
    // 2. Poll until state is ACTIVE
    let fileInfo = await ai.files.get({ name: uploadResult.name })
    logger.info({ action: 'video_analyze_processing', details: { name: fileInfo.name, state: fileInfo.state } })
    
    while (fileInfo.state === 'PROCESSING') {
      await delay(3000)
      fileInfo = await ai.files.get({ name: uploadResult.name })
    }

    if (fileInfo.state === 'FAILED') {
      throw new Error(`Video processing failed in Gemini AI Studio for file: ${fileInfo.name}`)
    }

    logger.info({ action: 'video_analyze_ready', details: { name: fileInfo.name, state: fileInfo.state } })

    // 3. Generate Content
    const response = await ai.models.generateContent({
      model: selection.modelId,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: fileInfo.uri, mimeType: fileInfo.mimeType } },
            { text: promptText },
          ],
        },
      ],
    })

    const resultText = response.text || ''
    logger.info({ action: 'video_analyze_completed', details: { promptLength: resultText.length } })
    
    return resultText

  } catch (error) {
    logger.error({ action: 'video_analyze_error', error })
    throw error
  }
}
