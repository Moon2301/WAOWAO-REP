import { type Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { getArtStylePrompt } from '@/lib/constants'
import { createScopedLogger } from '@/lib/logging/core'
import { type TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '../shared'
import {
  assertTaskActive,
  getProjectModels,
  resolveImageSourceFromGeneration,
  toSignedUrlIfCos,
  uploadImageSourceToCos,
} from '../utils'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import {
  type AnyObj,
  type PanelCharacterReference,
  findCharacterByName,
  parseImageUrls,
  parsePanelCharacterReferences,
  pickFirstString,
  resolveNovelData,
} from './image-task-handler-shared'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { parseLocationAvailableSlots } from '@/lib/location-available-slots'

type ProjectData = Awaited<ReturnType<typeof resolveNovelData>>

// ─── helpers ────────────────────────────────────────────────────────────────

function parseJsonUnknown(raw: string | null | undefined): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Thay thế nhân vật cũ bằng nhân vật mới trong danh sách characters của panel.
 * - Nếu fromName tồn tại → thay thế entry đó bằng toCharacter (giữ slot cũ).
 * - Nếu fromName không tồn tại → thêm toCharacter vào cuối (best-effort).
 */
function swapCharacterInList(
  panelCharacters: PanelCharacterReference[],
  fromName: string,
  toName: string,
  toAppearanceName: string | null,
): PanelCharacterReference[] {
  const fromLower = fromName.toLowerCase().trim()

  const foundIndex = panelCharacters.findIndex((ref) => {
    const refLower = ref.name.toLowerCase().trim()
    if (refLower === fromLower) return true
    // alias matching — "顾娘子/顾盼之" matches "顾娘子"
    return ref.name
      .toLowerCase()
      .split('/')
      .map((s) => s.trim())
      .includes(fromLower)
  })

  const newEntry: PanelCharacterReference = {
    name: toName,
    ...(toAppearanceName ? { appearance: toAppearanceName } : {}),
  }

  if (foundIndex >= 0) {
    const existing = panelCharacters[foundIndex]
    return panelCharacters.map((ref, i) =>
      i === foundIndex
        ? { ...newEntry, ...(existing.slot ? { slot: existing.slot } : {}) }
        : ref,
    )
  }

  // fromName not found — append toCharacter
  return [...panelCharacters, newEntry]
}

/**
 * Build the storyboard context JSON injected into NP_SINGLE_PANEL_IMAGE.
 * Mirrors the structure from panel-image-task-handler → buildPanelPromptContext().
 */
function buildSwapPromptContext(params: {
  panel: {
    id: string
    shotType: string | null
    cameraMove: string | null
    description: string | null
    imagePrompt: string | null
    videoPrompt: string | null
    location: string | null
    srtSegment: string | null
    photographyRules: string | null
    actingNotes: string | null
  }
  swappedCharacters: PanelCharacterReference[]
  projectData: ProjectData
  fromCharacterName: string
  toCharacterName: string
}) {
  const { panel, swappedCharacters, projectData, fromCharacterName, toCharacterName } = params

  const characterContexts = swappedCharacters.map((reference) => {
    const character = findCharacterByName(projectData.characters || [], reference.name)
    if (!character) {
      return {
        name: reference.name,
        appearance: reference.appearance || null,
        description: '无角色外貌数据',
      }
    }

    const appearances = character.appearances || []
    const matchedAppearance =
      (reference.appearance
        ? appearances.find(
            (a) => (a.changeReason || '').toLowerCase() === reference.appearance!.toLowerCase(),
          )
        : null) ?? appearances[0] ?? null

    const descriptions: string[] = (() => {
      try {
        const parsed = JSON.parse((matchedAppearance as { descriptions?: string | null })?.descriptions || 'null')
        return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
      } catch {
        return []
      }
    })()

    const selectedIndex =
      typeof (matchedAppearance as { selectedIndex?: number | null })?.selectedIndex === 'number'
        ? (matchedAppearance as { selectedIndex?: number | null }).selectedIndex
        : 0
    const description =
      descriptions[selectedIndex ?? 0] ||
      descriptions[0] ||
      (matchedAppearance as { description?: string | null })?.description ||
      '无角色外貌数据'

    return {
      name: character.name,
      appearance: (matchedAppearance as { changeReason?: string | null })?.changeReason || null,
      description,
      slot: reference.slot || null,
    }
  })

  const locationContext = (() => {
    if (!panel.location) return null
    const matchedLocation = (projectData.locations || []).find(
      (item) => item.name.toLowerCase() === panel.location!.toLowerCase(),
    )
    if (!matchedLocation) return null
    const selectedImage =
      (matchedLocation.images || []).find((item) => item.isSelected) || matchedLocation.images?.[0]
    return {
      name: matchedLocation.name,
      description: selectedImage?.description || null,
      available_slots: parseLocationAvailableSlots(selectedImage?.availableSlots),
    }
  })()

  return {
    panel: {
      panel_id: panel.id,
      shot_type: panel.shotType || '',
      camera_move: panel.cameraMove || '',
      description: panel.description || '',
      image_prompt: panel.imagePrompt || '',
      video_prompt: panel.videoPrompt || '',
      location: panel.location || '',
      characters: swappedCharacters,
      source_text: panel.srtSegment || '',
      photography_rules: parseJsonUnknown(panel.photographyRules),
      acting_notes: parseJsonUnknown(panel.actingNotes),
    },
    context: {
      character_appearances: characterContexts,
      location_reference: locationContext,
    },
    // Extra hint for the image model
    swap_instruction: {
      replaced_character: fromCharacterName,
      replacement_character: toCharacterName,
    },
  }
}

/**
 * Collect reference images for the swap:
 * 1. Original panel image (layout reference — most important)
 * 2. New character's appearance image (so the model knows the new character's look)
 * 3. Location image (optional)
 */
function buildSwapReferenceImages(params: {
  originalPanelImageUrl: string | null
  toCharacterName: string
  toAppearanceName: string | null
  projectData: ProjectData
  panelLocation: string | null
}): string[] {
  const refs: string[] = []

  // 1. Original panel image as layout reference
  const panelSigned = toSignedUrlIfCos(params.originalPanelImageUrl, 3600)
  if (panelSigned) refs.push(panelSigned)

  // 2. New character appearance image
  const toCharacter = findCharacterByName(params.projectData.characters || [], params.toCharacterName)

  if (toCharacter) {
    const appearances = toCharacter.appearances || []
    const matchedAppearance = params.toAppearanceName
      ? appearances.find(
          (a) => (a.changeReason || '').toLowerCase() === params.toAppearanceName!.toLowerCase(),
        ) ?? appearances[0]
      : appearances[0]

    if (matchedAppearance) {
      const imageUrls = parseImageUrls(
        (matchedAppearance as { imageUrls?: string | null }).imageUrls || null,
        'characterAppearance.imageUrls',
      )
      const selectedIndex =
        typeof (matchedAppearance as { selectedIndex?: number | null }).selectedIndex === 'number'
          ? (matchedAppearance as { selectedIndex?: number | null }).selectedIndex
          : null
      const selectedUrl =
        selectedIndex !== null && selectedIndex !== undefined ? imageUrls[selectedIndex] : null
      const key =
        selectedUrl ||
        imageUrls[0] ||
        (matchedAppearance as { imageUrl?: string | null }).imageUrl ||
        null
      const signed = toSignedUrlIfCos(key, 3600)
      if (signed) refs.push(signed)
    }
  }

  // 3. Location image (optional)
  if (params.panelLocation) {
    const location = (params.projectData.locations || []).find(
      (loc) => loc.name.toLowerCase() === params.panelLocation!.toLowerCase(),
    )
    if (location) {
      const images = location.images || []
      const selected = images.find((img) => img.isSelected) || images[0]
      const signed = toSignedUrlIfCos(selected?.imageUrl, 3600)
      if (signed) refs.push(signed)
    }
  }

  return refs
}

// ─── main handler ────────────────────────────────────────────────────────────

export async function handlePanelCharacterSwapTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj

  const panelId = pickFirstString(payload.panelId, job.data.targetId)
  if (!panelId) throw new Error('panel_character_swap: panelId missing')

  const fromCharacterName = pickFirstString(payload.fromCharacterName)
  if (!fromCharacterName) throw new Error('panel_character_swap: fromCharacterName missing')

  const toCharacterName = pickFirstString(payload.toCharacterName)
  if (!toCharacterName) throw new Error('panel_character_swap: toCharacterName missing')

  const toAppearanceName = pickFirstString(payload.toAppearanceName) // optional

  const logger = createScopedLogger({
    module: 'worker.panel-character-swap',
    action: 'panel_character_swap',
    requestId: job.data.trace?.requestId || undefined,
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: job.data.userId,
  })

  // ── 1. Load panel ──────────────────────────────────────────────────────────
  await reportTaskProgress(job, 5, { stage: 'load_panel' })

  const panel = await prisma.novelPromotionPanel.findUnique({ where: { id: panelId } })
  if (!panel) throw new Error(`Panel not found: ${panelId}`)

  // ── 2. Load project data + model config ───────────────────────────────────
  const projectData = await resolveNovelData(job.data.projectId)
  if (!projectData.videoRatio) throw new Error('Project videoRatio not configured')

  const modelConfig = await getProjectModels(job.data.projectId, job.data.userId)
  const modelKey = modelConfig.storyboardModel
  if (!modelKey) throw new Error('Storyboard model not configured')

  // ── 3. Validate toCharacter exists in project ─────────────────────────────
  const toCharacter = findCharacterByName(projectData.characters || [], toCharacterName)
  if (!toCharacter) throw new Error(`Character not found in project: ${toCharacterName}`)

  logger.info({
    message: 'panel character swap started',
    details: {
      panelId,
      fromCharacterName,
      toCharacterName,
      toAppearanceName,
      hasOriginalImage: !!panel.imageUrl,
    },
  })

  // ── 4. Build swapped character list ───────────────────────────────────────
  await reportTaskProgress(job, 12, { stage: 'prepare_swap_context' })

  const originalCharacters = parsePanelCharacterReferences(panel.characters)
  const swappedCharacters = swapCharacterInList(
    originalCharacters,
    fromCharacterName,
    toCharacterName,
    toAppearanceName,
  )

  // ── 5. Build prompt (NP_SINGLE_PANEL_IMAGE + layout hint) ─────────────────
  const promptContext = buildSwapPromptContext({
    panel: {
      id: panel.id,
      shotType: panel.shotType,
      cameraMove: panel.cameraMove,
      description: panel.description,
      imagePrompt: panel.imagePrompt,
      videoPrompt: panel.videoPrompt,
      location: panel.location,
      srtSegment: panel.srtSegment,
      photographyRules: panel.photographyRules,
      actingNotes: panel.actingNotes,
    },
    swappedCharacters,
    projectData,
    fromCharacterName,
    toCharacterName,
  })

  const aspectRatio = projectData.videoRatio
  const artStyle = getArtStylePrompt(modelConfig.artStyle, job.data.locale)

  const keepLayoutHint =
    job.data.locale === 'en'
      ? `Keep the exact same composition, shot framing, camera angle, and background as the reference panel image. Only replace character "${fromCharacterName}" with character "${toCharacterName}".`
      : `保持与参考图完全相同的构图、镜头框架、摄影角度和背景。仅将角色"${fromCharacterName}"替换为角色"${toCharacterName}"。`

  const styleInstruction = artStyle ? `${keepLayoutHint} ${artStyle}` : keepLayoutHint

  const prompt = buildPrompt({
    promptId: PROMPT_IDS.NP_SINGLE_PANEL_IMAGE,
    locale: job.data.locale,
    variables: {
      aspect_ratio: aspectRatio,
      storyboard_text_json_input: JSON.stringify(promptContext, null, 2),
      source_text: panel.srtSegment || panel.description || '无',
      style: styleInstruction,
    },
  })

  logger.info({
    message: 'panel character swap prompt resolved',
    details: { promptLength: prompt.length },
  })

  // ── 6. Collect reference images ────────────────────────────────────────────
  await reportTaskProgress(job, 20, { stage: 'collect_references' })
  await assertTaskActive(job, 'collect_references')

  const rawRefs = buildSwapReferenceImages({
    originalPanelImageUrl: panel.imageUrl,
    toCharacterName,
    toAppearanceName,
    projectData,
    panelLocation: panel.location,
  })
  const refs = await normalizeReferenceImagesForGeneration(rawRefs)

  logger.info({
    message: 'panel character swap references resolved',
    details: { rawCount: rawRefs.length, normalizedCount: refs.length },
  })

  // ── 7. Generate new panel image ────────────────────────────────────────────
  await reportTaskProgress(job, 30, { stage: 'generate_swap_image' })
  await assertTaskActive(job, 'generate_swap_image')

  const source = await resolveImageSourceFromGeneration(job, {
    userId: job.data.userId,
    modelId: modelKey,
    prompt,
    options: {
      referenceImages: refs,
      aspectRatio,
    },
    allowTaskExternalIdResume: true,
    pollProgress: { start: 35, end: 88 },
  })

  // ── 8. Upload result to object storage ─────────────────────────────────────
  await reportTaskProgress(job, 90, { stage: 'upload_swap_result' })
  const cosKey = await uploadImageSourceToCos(source, 'panel-swap', `${panelId}-${toCharacterName}`)

  // ── 9. Persist to DB (Option A) — save to candidateImages for user review ──
  await assertTaskActive(job, 'persist_swap_result')

  const existingCandidates: string[] = (() => {
    try {
      const parsed = JSON.parse(panel.candidateImages || 'null')
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
    } catch {
      return []
    }
  })()

  // Prepend new swap result so it appears first in the candidate list
  const newCandidates = [cosKey, ...existingCandidates]

  await prisma.novelPromotionPanel.update({
    where: { id: panel.id },
    data: { candidateImages: JSON.stringify(newCandidates) },
  })

  await reportTaskProgress(job, 100, {
    stage: 'swap_done',
    meta: {
      panelId,
      fromCharacterName,
      toCharacterName,
      candidateImageUrl: cosKey,
    },
  })

  logger.info({
    message: 'panel character swap completed',
    details: { panelId, cosKey },
  })

  return {
    panelId,
    fromCharacterName,
    toCharacterName,
    candidateImageUrl: cosKey,
    totalCandidates: newCandidates.length,
  }
}
