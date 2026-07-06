import { NextRequest } from 'next/server'
import { getObjectStream, guessContentTypeFromKey } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'

export const runtime = 'nodejs'

/**
 * Proxy video từ storage cho browser (hỗ trợ Range để seek).
 *
 * Trước đây route này tự fetch lại chính app qua HTTP
 * (http://127.0.0.1:3000/api/storage/sign?...) → ECONNREFUSED khi app
 * bind hostname khác / đang khởi động. Giờ đọc thẳng từ storage.
 */
export const GET = apiHandler(async (
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> }
) => {
    const { projectId } = await context.params
    const { searchParams } = new URL(request.url)
    const videoKey = searchParams.get('key')

    if (!videoKey) {
        throw new ApiError('INVALID_PARAMS')
    }

    const authResult = await requireProjectAuthLight(projectId)
    if (isErrorResponse(authResult)) return authResult

    const range = request.headers.get('range') || undefined

    // URL ngoài (kết quả provider chưa lưu về storage) → fetch qua HTTP
    if (videoKey.startsWith('http://') || videoKey.startsWith('https://')) {
        const response = await fetch(videoKey, {
            headers: range ? { Range: range } : undefined,
        })
        if (!response.ok) {
            throw new Error(`Failed to fetch video: ${response.statusText}`)
        }
        const headers = new Headers()
        headers.set('Content-Type', response.headers.get('content-type') || 'video/mp4')
        headers.set('Cache-Control', 'no-cache')
        const contentLength = response.headers.get('content-length')
        const contentRange = response.headers.get('content-range')
        if (contentLength) headers.set('Content-Length', contentLength)
        if (contentRange) headers.set('Content-Range', contentRange)
        headers.set('Accept-Ranges', 'bytes')
        return new Response(response.body, {
            status: response.status === 206 ? 206 : 200,
            headers,
        })
    }

    return await streamFromStorage(videoKey.replace(/^\/+/, ''), range)
})

async function streamFromStorage(key: string, range?: string): Promise<Response> {
    let stream
    try {
        stream = await getObjectStream(key, range)
    } catch {
        throw new ApiError('NOT_FOUND', { message: `Video not found: ${key.substring(0, 120)}` })
    }

    const headers = new Headers()
    headers.set('Content-Type', stream.contentType || guessContentTypeFromKey(key) || 'video/mp4')
    headers.set('Cache-Control', 'private, max-age=3600')
    headers.set('Accept-Ranges', 'bytes')
    if (stream.contentLength !== undefined) headers.set('Content-Length', String(stream.contentLength))
    if (stream.contentRange) headers.set('Content-Range', stream.contentRange)

    return new Response(stream.body, { status: stream.status, headers })
}
