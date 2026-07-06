import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { findBuiltinCapabilities } from '@/lib/model-capabilities/catalog'

/**
 * Snap thời lượng video về giá trị được model hỗ trợ (vd. Veo: 4/6/8s).
 * Ưu tiên tier nhỏ nhất >= desired; nếu vượt max thì lấy max.
 *
 * Server-only: đọc capability catalog từ filesystem.
 */
export function snapVideoDurationForModel(modelKey: string, desiredDuration: number): number {
  if (!Number.isFinite(desiredDuration) || desiredDuration <= 0) return 4

  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed) return Math.max(1, Math.ceil(desiredDuration))

  const capabilities = findBuiltinCapabilities('video', parsed.provider, parsed.modelId)
  const options = capabilities?.video?.durationOptions
  if (!Array.isArray(options) || options.length === 0) {
    return Math.max(1, Math.ceil(desiredDuration))
  }

  const allowed = options.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (allowed.length === 0) return Math.max(1, Math.ceil(desiredDuration))
  if (allowed.includes(desiredDuration)) return desiredDuration

  const sorted = [...allowed].sort((a, b) => a - b)
  const ceilTier = sorted.find((d) => d >= desiredDuration)
  return ceilTier ?? sorted[sorted.length - 1]
}
