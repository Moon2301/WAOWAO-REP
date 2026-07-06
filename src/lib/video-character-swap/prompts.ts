/**
 * Prompt templates for chunk-based character swap (analyze → optional img2img → i2v).
 */

/** Gemini: chỉ mô tả chuyển động / camera, không mô tả ngoại hình nhân vật. */
export function buildVideoAnalyzePrompt(characterHint?: string): string {
  const base = `You are analyzing a source video clip that will be re-generated with image-to-video AI.
Extract ONLY motion, action, and camera behavior. Another reference image will supply character identity.

Write ONE paragraph in English (present tense, cinematic) covering:
1) Body actions and gestures (what the subject does, step by step through the clip)
2) Camera behavior (static, pan, zoom, dolly, tilt, rack focus)
3) Brief environment and lighting mood (only what affects motion readability)
4) Rhythm and pacing of movement

RULES:
- Do NOT describe face, hair, clothing, age, or identity
- Do NOT describe the reference character image or a "static opening shot of the character"
- Do NOT start with "The video features" — start directly with action/camera
- If no person is visible, describe only camera and environment motion`

  const hint = characterHint?.trim()
  if (hint) {
    return `${base}\n\nFocus only on the subject matching: "${hint}". Ignore other people.`
  }
  return base
}

/** Prompt img2img: ghép nhân vật tham chiếu lên frame đầu của chunk gốc. */
export const CHUNK_FIRST_FRAME_SWAP_PROMPT =
  'Replace the person in this scene with the target reference character. Preserve the exact pose, body position, composition, camera angle, background, and lighting. Match facial features and appearance to the reference image. Single cinematic frame, photorealistic continuity.'

export function buildChunkVideoGenerationPrompt(input: {
  motionDescription: string
  userDirective?: string
  artStyle?: string
  characterHint?: string
}): string {
  const motion = input.motionDescription.trim()
  const parts = [
    'Cinematic video. The main subject must keep the same identity and appearance as the starting reference image for the entire clip.',
    'Smooth continuous motion from first frame to last frame. No frozen pose, no slideshow, no holding a still portrait at the start.',
    motion ? `Motion and camera: ${motion}` : '',
    input.userDirective?.trim() ? `Direction: ${input.userDirective.trim()}` : '',
    input.characterHint?.trim() ? `Subject: ${input.characterHint.trim()}` : '',
    input.artStyle?.trim() ? `Style: ${input.artStyle.trim()}` : '',
    'Maintain temporal coherence, consistent character identity, and natural movement.',
  ].filter((line) => line.length > 0)
  return parts.join(' ')
}
