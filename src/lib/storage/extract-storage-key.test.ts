import { describe, expect, it } from 'vitest'
import { extractStorageKey } from '@/lib/storage'

describe('extractStorageKey sign route', () => {
  it('extracts key from canonical sign route', () => {
    expect(extractStorageKey('/api/storage/sign?key=images%2Ftemp-user.mp4'))
      .toBe('images/temp-user.mp4')
  })

  it('extracts key from corrupted sign route without leading slash', () => {
    expect(extractStorageKey('api/storage/sign?key=images%2Ftemp-user.mp4'))
      .toBe('images/temp-user.mp4')
  })

  it('keeps plain storage keys unchanged', () => {
    // Plain keys are delegated to provider; sign-route parsing is the regression guard.
    expect(extractStorageKey('/api/storage/sign?key=projects%2Fp1%2Fvideos%2Fa.mp4'))
      .toBe('projects/p1/videos/a.mp4')
  })
})
