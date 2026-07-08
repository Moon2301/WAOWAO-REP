import 'dotenv/config'
import { prisma } from './src/lib/prisma'

async function checkMergeTask() {
  const task = await prisma.task.findUnique({
    where: { id: '6d0ba76b-430f-4119-965c-f9091bc341bf' }
  })
  if (task) {
    console.log(JSON.stringify(task.payload, null, 2))
  }
}

checkMergeTask()
