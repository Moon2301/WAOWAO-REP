import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const t = await prisma.task.findFirst({
    where: { type: 'video_frame_merge' },
    orderBy: { createdAt: 'desc' }
  });
  console.log(t?.errorMessage);
}
main().finally(() => prisma.$disconnect())
