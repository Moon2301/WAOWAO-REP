import fs from 'fs'
import path from 'path'
import os from 'os'
import util from 'util'
import { exec } from 'child_process'
import type { Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from '@/lib/task/types'
import { assertTaskActive } from '../utils'
import { uploadObject, getObjectBuffer, generateUniqueKey } from '@/lib/storage'
import { getProviderConfig } from '@/lib/api-config'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { saveChunkResultVideoByMediaId } from '@/lib/video-frame/fbf-result-persistence'
import { reportTaskProgress } from '../shared'

const execAsync = util.promisify(exec)

export async function handleVideoCharacterSwapMergeTask(job: Job<TaskJobData>) {
  const logger = createScopedLogger({ module: 'worker.video-character-swap-merge', taskId: job.data.taskId })
  const { projectId, userId } = job.data
  const { chunkUrls, originalAudioUrl, originalDurationSec } = job.data.payload as {
    chunkUrls: string[]
    originalAudioUrl?: string
    originalDurationSec?: number
  }

  if (!chunkUrls || chunkUrls.length === 0) {
    throw new Error('Thiếu tham số chunkUrls')
  }

  await reportTaskProgress(job, 5, { stage: 'init', message: `Starting chunk concatenation for ${chunkUrls.length} AI video chunks...` })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-swap-merge-'))
  const listFilePath = path.join(tempDir, 'chunks.txt')
  const mergedVideoPath = path.join(tempDir, 'merged_video.mp4')
  const originalAudioPath = path.join(tempDir, 'audio.aac')
  const finalVideoPath = path.join(tempDir, 'final.mp4')

  try {
    logger.info({ message: '1. Downloading chunks' })
    const localChunkPaths: string[] = []

    for (let i = 0; i < chunkUrls.length; i++) {
      const chunkUrl = chunkUrls[i]
      const chunkPath = path.join(tempDir, `chunk_${i}.mp4`)
      
      const { resolveStorageKeyFromMediaValue } = await import('@/lib/media/service')
      const resolvedKey = await resolveStorageKeyFromMediaValue(chunkUrl)
      
      if (resolvedKey) {
        const buf = await getObjectBuffer(resolvedKey)
        fs.writeFileSync(chunkPath, buf)
      } else if (chunkUrl.startsWith('http')) {
        let headers: Record<string, string> = {}
        if (chunkUrl.includes('generativelanguage.googleapis.com')) {
           const { apiKey } = await getProviderConfig(userId, 'google')
           headers = { 'x-goog-api-key': apiKey }
        }
        const res = await fetch(chunkUrl, { headers })
        if (!res.ok) throw new Error(`Failed to fetch chunk ${i}: ${res.statusText}`)
        fs.writeFileSync(chunkPath, Buffer.from(await res.arrayBuffer()))
      } else {
        const objKey = chunkUrl.replace(/^\/+/, '')
        const buf = await getObjectBuffer(objKey)
        fs.writeFileSync(chunkPath, buf)
      }
      
      localChunkPaths.push(chunkPath)
      await reportTaskProgress(job, 5 + Math.floor((i + 1) / chunkUrls.length * 40), { stage: 'download_chunks', message: `Downloaded AI video chunk (${i + 1}/${chunkUrls.length})...` })
    }

    await assertTaskActive(job, 'after_download')

    logger.info({ message: '2. Concatenating chunks' })
    
    // Create concat list file
    let listContent = ''
    for (const p of localChunkPaths) {
      // ffmpeg requires forward slashes or escaped backslashes for paths in txt file
      const escapedPath = p.replace(/\\/g, '/')
      listContent += `file '${escapedPath}'\n`
    }
    fs.writeFileSync(listFilePath, listContent)
    
    await execAsync(`ffmpeg -f concat -safe 0 -i "${listFilePath}" -c copy "${mergedVideoPath}"`)
    
    await reportTaskProgress(job, 60, { stage: 'concat_chunks', message: 'Concatenating video chunks seamlessly using FFmpeg...' })

    let finalVideoKey = ''
    let finalVideoUrlToReturn = ''
    
    // Check if we need to trim to exact original duration
    let outputVideoPath = mergedVideoPath
    if (typeof originalDurationSec === 'number' && originalDurationSec > 0) {
      const trimmedPath = path.join(tempDir, 'trimmed_video.mp4')
      await execAsync(`ffmpeg -i "${mergedVideoPath}" -t ${originalDurationSec} -c copy "${trimmedPath}"`)
      outputVideoPath = trimmedPath
    }

    let finalBuffer: Buffer

    if (originalAudioUrl) {
      logger.info({ message: '3. Downloading and merging audio' })
      let objKey = originalAudioUrl
      if (objKey.startsWith('http')) {
        const parsed = new URL(objKey)
        objKey = parsed.pathname.replace(/^\/+/, '')
      } else {
        objKey = objKey.replace(/^\/+/, '')
      }
      const audioBuf = await getObjectBuffer(objKey)
      fs.writeFileSync(originalAudioPath, audioBuf)

      await execAsync(`ffmpeg -i "${outputVideoPath}" -i "${originalAudioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${finalVideoPath}"`)
      
      logger.info({ message: '4. Uploading final video' })
      finalBuffer = fs.readFileSync(finalVideoPath)
    } else {
      logger.info({ message: '3. Uploading final video directly' })
      finalBuffer = fs.readFileSync(outputVideoPath)
    }

    finalVideoKey = generateUniqueKey(`projects/${projectId}/videos/`, 'mp4')
    await uploadObject(finalBuffer, finalVideoKey, 3, 'video/mp4')

    const mediaRef = await ensureMediaObjectFromStorageKey(finalVideoKey, {
      mimeType: 'video/mp4',
      sizeBytes: finalBuffer.length,
    })
    await saveChunkResultVideoByMediaId(projectId, mediaRef.id)
    finalVideoUrlToReturn = mediaRef.url

    await reportTaskProgress(job, 100, { stage: 'completed', message: 'Final character swap video merged and ready for playback!' })
    
    return {
      finalVideoUrl: finalVideoUrlToReturn,
      finalVideoKey,
    }

  } finally {
    logger.info({ message: 'Cleaning up temp files' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
