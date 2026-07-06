import { describe, expect, it } from 'vitest'
import {
  filterNormalVideoModelOptions,
  isFirstLastFrameOnlyModel,
  supportsFirstLastFrame,
} from '@/lib/model-capabilities/video-model-options'
import { snapVideoDurationForModel } from '@/lib/model-capabilities/video-duration-snap'
import type { VideoModelOption } from '@/lib/novel-promotion/stages/video-stage-runtime/types'

describe('video model options partition', () => {
  const models: VideoModelOption[] = [
    {
      value: 'p::normal',
      label: 'normal',
      capabilities: {
        video: {
          generationModeOptions: ['normal'],
          firstlastframe: false,
        },
      },
    },
    {
      value: 'p::firstlast-only',
      label: 'firstlast-only',
      capabilities: {
        video: {
          generationModeOptions: ['firstlastframe'],
          firstlastframe: true,
        },
      },
    },
    {
      value: 'p::both',
      label: 'both',
      capabilities: {
        video: {
          generationModeOptions: ['normal', 'firstlastframe'],
          firstlastframe: true,
        },
      },
    },
    {
      value: 'p::custom-no-capability',
      label: 'custom-no-capability',
    },
  ]

  it('detects firstlastframe support and firstlastframe-only capability', () => {
    expect(supportsFirstLastFrame(models[0])).toBe(false)
    expect(supportsFirstLastFrame(models[1])).toBe(true)
    expect(supportsFirstLastFrame(models[2])).toBe(true)
    expect(supportsFirstLastFrame(models[3])).toBe(false)

    expect(isFirstLastFrameOnlyModel(models[0])).toBe(false)
    expect(isFirstLastFrameOnlyModel(models[1])).toBe(true)
    expect(isFirstLastFrameOnlyModel(models[2])).toBe(false)
    expect(isFirstLastFrameOnlyModel(models[3])).toBe(false)
  })

  it('filters out firstlastframe-only models from normal video model list', () => {
    const normalModels = filterNormalVideoModelOptions(models)
    expect(normalModels.map((item) => item.value)).toEqual([
      'p::normal',
      'p::both',
      'p::custom-no-capability',
    ])
  })

  it('snaps duration to the smallest supported tier for Veo models', () => {
    const modelKey = 'google::veo-3.1-fast-generate-preview'
    expect(snapVideoDurationForModel(modelKey, 3.068752999999999)).toBe(4)
    expect(snapVideoDurationForModel(modelKey, 5)).toBe(6)
    expect(snapVideoDurationForModel(modelKey, 7)).toBe(8)
    expect(snapVideoDurationForModel(modelKey, 4)).toBe(4)
  })
})
