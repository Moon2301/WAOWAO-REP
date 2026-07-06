import { NextRequest } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getObjectStream, guessContentTypeFromKey } from '@/lib/storage'

export const runtime = 'nodejs'

/**
 * Trả nội dung object trực tiếp (stream, hỗ trợ Range).
 *
 * Trước đây route này redirect browser sang presigned URL của MinIO —
 * nhưng URL đó dùng endpoint nội bộ docker (http://minio:9000) mà browser
 * không phân giải được → ERR_NAME_NOT_RESOLVED, mọi ảnh/video trống trơn.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')?.replace(/^\/+/, '')

  if (!key) {
    throw new ApiError('INVALID_PARAMS')
  }

  const range = request.headers.get('range') || undefined

  let stream
  try {
    stream = await getObjectStream(key, range)
  } catch {
    throw new ApiError('NOT_FOUND', { message: `Object not found: ${key.substring(0, 120)}` })
  }

  const headers = new Headers()
  headers.set('Content-Type', stream.contentType || guessContentTypeFromKey(key))
  headers.set('Cache-Control', 'private, max-age=3600')
  headers.set('Accept-Ranges', 'bytes')
  if (stream.contentLength !== undefined) headers.set('Content-Length', String(stream.contentLength))
  if (stream.contentRange) headers.set('Content-Range', stream.contentRange)

  return new Response(stream.body, { status: stream.status, headers })
})
