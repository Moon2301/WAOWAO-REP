import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getObjectBuffer, toFetchableUrl } from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'

interface PanelData {
  panelIndex: number | null
  description: string | null
  videoUrl: string | null
  lipSyncVideoUrl: string | null
}

interface StoryboardData {
  id: string
  clipId: string
  panels?: PanelData[]
}

interface ClipData {
  id: string
}


// Check if a file has audio track using ffprobe
const probeAudio = (filePath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        _ulogError(`ffprobe error on ${filePath}:`, err)
        resolve(false)
        return
      }
      const hasAudio = metadata.streams.some(s => s.codec_type === 'audio')
      resolve(hasAudio)
    });
  })
}

// Normalize a video: convert to 1280x720 30fps H264 video with stereo AAC audio
const normalizeVideo = (inputPath: string, outputPath: string, hasAudio: boolean): Promise<void> => {
  return new Promise((resolve, reject) => {
    // We use standard ffmpeg command execution via child_process exec
    // to normalize resolutions and frame rates, and add silent audio if needed.
    let cmd = ''
    if (hasAudio) {
      cmd = `ffmpeg -y -i "${inputPath}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -r 30 -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 "${outputPath}"`
    } else {
      cmd = `ffmpeg -y -i "${inputPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -r 30 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`
    }
    
    _ulogInfo(`Running normalization command: ${cmd}`)
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        _ulogError(`Normalization failed for ${inputPath}:`, error)
        _ulogError(`stderr: ${stderr}`)
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

// Concatenate normalized videos
const concatenateVideos = (inputsTxtPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${inputsTxtPath}" -c copy "${outputPath}"`
    _ulogInfo(`Running concat command: ${cmd}`)
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        _ulogError(`Concatenation failed:`, error)
        _ulogError(`stderr: ${stderr}`)
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params

  const body = await request.json()
  const { episodeId, panelPreferences } = body as {
    episodeId?: string
    panelPreferences?: Record<string, boolean>
  }

  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS', { message: 'Missing episodeId' })
  }

  // Auth check
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  // Get episode data
  const episode = await prisma.novelPromotionEpisode.findUnique({
    where: { id: episodeId },
    include: {
      storyboards: {
        include: {
          panels: { orderBy: { panelIndex: 'asc' } }
        },
        orderBy: { createdAt: 'asc' }
      },
      clips: {
        orderBy: { createdAt: 'asc' }
      }
    }
  })

  if (!episode) {
    throw new ApiError('NOT_FOUND', { message: 'Episode not found' })
  }

  const allStoryboards = episode.storyboards || []
  const allClips = episode.clips || []
  const videos: { description: string; videoUrl: string; clipIndex: number; panelIndex: number }[] = []

  for (const storyboard of allStoryboards) {
    const clipIndex = allClips.findIndex((clip) => clip.id === storyboard.clipId)
    const panels = storyboard.panels || []
    for (const panel of panels) {
      const panelKey = `${storyboard.id}-${panel.panelIndex || 0}`
      const preferLipSync = panelPreferences?.[panelKey] ?? true

      let videoUrl: string | null = null
      if (preferLipSync) {
        videoUrl = panel.lipSyncVideoUrl || panel.videoUrl
      } else {
        videoUrl = panel.videoUrl || panel.lipSyncVideoUrl
      }

      if (videoUrl) {
        videos.push({
          description: panel.description || `Panel`,
          videoUrl: videoUrl,
          clipIndex: clipIndex >= 0 ? clipIndex : 999,
          panelIndex: panel.panelIndex || 0,
        })
      }
    }
  }

  // Sort videos
  videos.sort((a, b) => {
    if (a.clipIndex !== b.clipIndex) {
      return a.clipIndex - b.clipIndex
    }
    return a.panelIndex - b.panelIndex
  })

  if (videos.length === 0) {
    throw new ApiError('INVALID_PARAMS', { message: 'No videos found in this episode' })
  }

  _ulogInfo(`Merging ${videos.length} videos for project ${projectId}, episode ${episodeId}`)

  // Create temporary directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-'))
  
  try {
    const downloadedPaths: string[] = []
    const normalizedPaths: string[] = []

    // 1. Download all video chunks
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]
      let pathname = video.videoUrl
      if (video.videoUrl.startsWith('http://') || video.videoUrl.startsWith('https://')) {
        try {
          pathname = new URL(toFetchableUrl(video.videoUrl)).pathname
        } catch {}
      }
      const ext = path.extname(pathname.split('?')[0]) || '.mp4'
      const inputPath = path.join(tempDir, `input_${i}${ext}`)
      
      let videoData: Buffer
      const storageKey = await resolveStorageKeyFromMediaValue(video.videoUrl)
      
      if (video.videoUrl.startsWith('http://') || video.videoUrl.startsWith('https://')) {
        const response = await fetch(toFetchableUrl(video.videoUrl))
        if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`)
        videoData = Buffer.from(await response.arrayBuffer())
      } else if (storageKey) {
        videoData = await getObjectBuffer(storageKey)
      } else {
        const response = await fetch(toFetchableUrl(video.videoUrl))
        if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`)
        videoData = Buffer.from(await response.arrayBuffer())
      }

      fs.writeFileSync(inputPath, videoData)
      downloadedPaths.push(inputPath)
    }

    // 2. Probe and normalize each video chunk
    for (let i = 0; i < downloadedPaths.length; i++) {
      const inputPath = downloadedPaths[i]
      const normalizedPath = path.join(tempDir, `normalized_${i}.mp4`)
      
      const hasAudio = await probeAudio(inputPath)
      await normalizeVideo(inputPath, normalizedPath, hasAudio)
      normalizedPaths.push(normalizedPath)
    }

    // 3. Create concatenation text file
    const inputsTxtPath = path.join(tempDir, 'inputs.txt')
    const fileContent = normalizedPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n')
    fs.writeFileSync(inputsTxtPath, fileContent)

    // 4. Concatenate videos
    const outputPath = path.join(tempDir, 'output.mp4')
    await concatenateVideos(inputsTxtPath, outputPath)

    // 5. Read output file into buffer
    const mergedVideoBuffer = fs.readFileSync(outputPath)

    // Clean up temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (cleanupError) {
      _ulogError('Failed to clean up temp merge directory:', cleanupError)
    }

    // Return the merged video as attachment
    const safeEpisodeName = (episode.name || `Episode_${episodeId}`).replace(/[\\/:*?"<>|]/g, '_')
    return new Response(mergedVideoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeEpisodeName)}.mp4"`
      }
    })

  } catch (error) {
    _ulogError('Failed to merge videos:', error)
    // Attempt clean up
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
    throw new ApiError('INTERNAL_ERROR', { message: 'Failed to merge videos' })
  }
})
