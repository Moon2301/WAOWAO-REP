import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import type { DeleteObjectsResult, ObjectStreamParams, ObjectStreamResult, SignedUrlParams, StorageProvider, UploadObjectParams, UploadObjectResult } from '@/lib/storage/types'
import { normalizeKey, toFetchableUrl } from '@/lib/storage/utils'

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads'

function resolveUploadPath(key: string): string {
  return path.join(process.cwd(), UPLOAD_DIR, normalizeKey(key))
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const

  async uploadObject(params: UploadObjectParams): Promise<UploadObjectResult> {
    const normalizedKey = normalizeKey(params.key)
    const filePath = resolveUploadPath(normalizedKey)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, params.body)
    return { key: normalizedKey }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await fs.unlink(resolveUploadPath(key))
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code
      if (code !== 'ENOENT') {
        throw error
      }
    }
  }

  async deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
    const validKeys = keys.filter((key) => typeof key === 'string' && key.trim().length > 0)
    let success = 0
    let failed = 0

    for (const key of validKeys) {
      try {
        await this.deleteObject(key)
        success += 1
      } catch {
        failed += 1
      }
    }

    return { success, failed }
  }

  async getSignedObjectUrl(params: SignedUrlParams): Promise<string> {
    void params.expiresInSeconds
    return `/api/files/${encodeURIComponent(normalizeKey(params.key))}`
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    return await fs.readFile(resolveUploadPath(key))
  }

  async getObjectStream(params: ObjectStreamParams): Promise<ObjectStreamResult> {
    const filePath = resolveUploadPath(params.key)
    const stat = await fs.stat(filePath)

    let start = 0
    let end = stat.size - 1
    let status: 200 | 206 = 200
    let contentRange: string | undefined

    if (params.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(params.range.trim())
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number.parseInt(match[1], 10) : Math.max(0, stat.size - Number.parseInt(match[2], 10))
        end = match[1] && match[2] ? Math.min(Number.parseInt(match[2], 10), stat.size - 1) : end
        if (start <= end && start < stat.size) {
          status = 206
          contentRange = `bytes ${start}-${end}/${stat.size}`
        } else {
          start = 0
          end = stat.size - 1
        }
      }
    }

    const nodeStream = createReadStream(filePath, { start, end })
    return {
      body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      status,
      contentLength: end - start + 1,
      contentRange,
    }
  }

  extractStorageKey(input: string | null | undefined): string | null {
    if (!input) return null
    if (input.startsWith('/api/files/')) {
      return normalizeKey(decodeURIComponent(input.replace('/api/files/', '')))
    }
    if (!input.startsWith('http') && !input.startsWith('/')) {
      return normalizeKey(input)
    }

    try {
      const parsed = new URL(input)
      return normalizeKey(parsed.pathname)
    } catch {
      return null
    }
  }

  toFetchableUrl(inputUrl: string): string {
    return toFetchableUrl(inputUrl)
  }

  generateUniqueKey(params: { prefix: string; ext: string }): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2, 8)
    return `images/${params.prefix}-${timestamp}-${random}.${params.ext}`
  }
}
