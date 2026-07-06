import fs from 'fs'
import { generateUniqueKey, uploadObject } from '@/lib/storage'

const OPTICAL_FLOW_SERVICE_URL = process.env.OPTICAL_FLOW_SERVICE_URL || 'http://localhost:8000'

/**
 * Calls the Python RAFT service to compute optical flow between two frames.
 * Returns the COS key of the uploaded motion vector .npy file.
 */
export async function computeMotionVectorsRaft(
  framePrevPath: string,
  frameCurrPath: string,
  projectId: string
): Promise<string> {
  const form = new FormData()
  const buf1 = fs.readFileSync(framePrevPath)
  const buf2 = fs.readFileSync(frameCurrPath)
  form.append('image1', new Blob([buf1]), 'image1.jpg')
  form.append('image2', new Blob([buf2]), 'image2.jpg')

  const response = await fetch(`${OPTICAL_FLOW_SERVICE_URL}/api/v1/flow`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Optical flow service error (${response.status}): ${text}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  
  // Upload to COS
  const finalKey = generateUniqueKey(`projects/${projectId}/videos/motion_vectors/`, 'npy')
  await uploadObject(buffer, finalKey, 3, 'application/octet-stream')
  
  return finalKey
}

/**
 * Calls the Python RAFT service to compute optical flow between original N-1 and N,
 * and then warp the processed N-1 image to align with N.
 * Returns the COS key of the uploaded warped image.
 */
export async function warpFrameRaft(
  framePrevOriginalPath: string,
  frameCurrOriginalPath: string,
  framePrevProcessedPath: string,
  projectId: string
): Promise<string> {
  const form = new FormData()
  const buf1 = fs.readFileSync(framePrevOriginalPath)
  const buf2 = fs.readFileSync(frameCurrOriginalPath)
  const buf3 = fs.readFileSync(framePrevProcessedPath)
  form.append('image1', new Blob([buf1]), 'image1.jpg')
  form.append('image2', new Blob([buf2]), 'image2.jpg')
  form.append('processed_image1', new Blob([buf3]), 'proc1.jpg')

  const response = await fetch(`${OPTICAL_FLOW_SERVICE_URL}/api/v1/warp`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Warp service error (${response.status}): ${text}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  
  // Upload warped image to COS
  const finalKey = generateUniqueKey(`projects/${projectId}/videos/frames_warped/`, 'jpg')
  await uploadObject(buffer, finalKey, 3, 'image/jpeg')
  
  return finalKey
}
