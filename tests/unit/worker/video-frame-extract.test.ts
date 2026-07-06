import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleVideoFrameExtractTask } from '@/lib/workers/handlers/video-frame-extract'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import type { Job } from 'bullmq'

// Mock dependencies
vi.mock('@/lib/logging/core', () => ({
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('@/lib/storage', () => ({
  uploadObject: vi.fn().mockResolvedValue(true),
  getObjectBuffer: vi.fn().mockResolvedValue(Buffer.from('mock-video-data')),
  generateUniqueKey: vi.fn((prefix, ext) => `${prefix}mock-key.${ext}`),
}))

vi.mock('@/lib/media/service', () => ({
  ensureMediaObjectFromStorageKey: vi.fn((key) => Promise.resolve({ url: `/${key}` })),
  resolveStorageKeyFromMediaValue: vi.fn((url) => Promise.resolve(url)),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `mock-task-id-${Math.random()}`, ...data })),
      update: vi.fn().mockResolvedValue(true),
      findUnique: vi.fn().mockResolvedValue({ id: 'mock-task', type: 'mock', payload: {} }),
    }
  }
}))

vi.mock('@/lib/task/queues', () => ({
  addTaskJob: vi.fn().mockResolvedValue(true),
}))

vi.mock('../utils', () => ({
  assertTaskActive: vi.fn().mockResolvedValue(true),
}))

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, cb) => {
    // Mock successful execution
    cb(null, { stdout: '10.5\n30000/1001\n', stderr: '' })
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdtempSync: vi.fn(() => '/mock/temp/dir'),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-data')),
    readdirSync: vi.fn().mockReturnValue(['frame_000001.jpg', 'frame_000002.jpg']),
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn(() => ({ size: 1024 })),
    rmSync: vi.fn(),
  }
})

describe('handleVideoFrameExtractTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should extract frames and enqueue child tasks', async () => {
    const mockJob = {
      data: {
        taskId: 'test-extract-task',
        userId: 'user-1',
        projectId: 'proj-1',
        type: TASK_TYPE.VIDEO_FRAME_EXTRACT,
        targetType: 'VideoFrameProcess',
        targetId: 'target-1',
        payload: {
          videoUrl: 'https://example.com/video.mp4',
          targetFps: 8,
          processingMode: 'img2img',
          modelId: 'test-model',
          temporalMode: 'none',
          extractOnly: false,
        }
      },
      updateProgress: vi.fn().mockResolvedValue(true),
    } as unknown as Job<TaskJobData>

    const result = await handleVideoFrameExtractTask(mockJob)

    expect(result.totalFrames).toBe(2)
    expect(result.targetFps).toBe(8)
    expect(result.frameTaskIds?.length).toBe(2)
    expect(result.mergeTaskId).toBeDefined()
    expect(mockJob.updateProgress).toHaveBeenCalledWith(100)
  })

  it('should only extract frames when extractOnly is true', async () => {
    const { addTaskJob } = await import('@/lib/task/queues')

    const mockJob = {
      data: {
        taskId: 'test-extract-only',
        userId: 'user-1',
        projectId: 'proj-1',
        type: TASK_TYPE.VIDEO_FRAME_EXTRACT,
        targetType: 'VideoFrameProcess',
        targetId: 'target-1',
        payload: {
          videoUrl: 'https://example.com/video.mp4',
          targetFps: 8,
          processingMode: 'img2img',
          extractOnly: true,
        }
      },
      updateProgress: vi.fn().mockResolvedValue(true),
    } as unknown as Job<TaskJobData>

    const result = await handleVideoFrameExtractTask(mockJob)

    expect(result.totalFrames).toBe(2)
    expect(result.frameKeys?.length).toBe(2)
    expect(result.extractOnly).toBe(true)
    expect(result.frameTaskIds).toBeUndefined()
    expect(addTaskJob).not.toHaveBeenCalled()
  })
})
