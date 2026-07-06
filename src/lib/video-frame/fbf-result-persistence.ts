import { prisma } from '@/lib/prisma'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

export async function saveFbfResultVideo(projectId: string, storageKey: string) {
  const mediaRef = await ensureMediaObjectFromStorageKey(storageKey.replace(/^\/+/, ''), {
    mimeType: 'video/mp4',
  })

  await prisma.novelPromotionProject.update({
    where: { projectId },
    data: { fbfResultVideoMediaId: mediaRef.id },
  })

  return mediaRef
}

export async function saveFbfResultVideoByMediaId(projectId: string, mediaId: string) {
  await prisma.novelPromotionProject.update({
    where: { projectId },
    data: { fbfResultVideoMediaId: mediaId },
  })
}

export async function clearFbfResultVideo(projectId: string) {
  await prisma.novelPromotionProject.updateMany({
    where: { projectId },
    data: { fbfResultVideoMediaId: null },
  })
}

export async function saveChunkResultVideoByMediaId(projectId: string, mediaId: string) {
  await prisma.novelPromotionProject.update({
    where: { projectId },
    data: { chunkResultVideoMediaId: mediaId },
  })
}

export async function clearChunkResultVideo(projectId: string) {
  await prisma.novelPromotionProject.updateMany({
    where: { projectId },
    data: { chunkResultVideoMediaId: null },
  })
}
