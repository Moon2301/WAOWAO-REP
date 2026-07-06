import { describe, expect, it } from 'vitest'
import { resolvePlayableImageUrl, resolvePlayableVideoUrl } from './playable-url'

describe('playable-url', () => {
  const projectId = 'proj-1'

  it('resolves raw storage keys through video-proxy', () => {
    expect(resolvePlayableVideoUrl('images/temp-user-1.mp4', projectId))
      .toBe('/api/novel-promotion/proj-1/video-proxy?key=images%2Ftemp-user-1.mp4')
  })

  it('resolves storage sign routes through video-proxy', () => {
    expect(resolvePlayableVideoUrl('/api/storage/sign?key=images%2Ftemp-user-1.mp4', projectId))
      .toBe('/api/novel-promotion/proj-1/video-proxy?key=images%2Ftemp-user-1.mp4')
  })

  it('keeps media route urls unchanged', () => {
    expect(resolvePlayableVideoUrl('/m/abc123', projectId)).toBe('/m/abc123')
  })

  it('resolves image storage keys through sign route', () => {
    expect(resolvePlayableImageUrl('images/temp-user-1.jpg', projectId))
      .toBe('/api/storage/sign?key=images%2Ftemp-user-1.jpg')
  })
})
