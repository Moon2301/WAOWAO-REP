import { prisma } from '@/lib/prisma'
import { addTaskJob } from '@/lib/task/queues'
import { TASK_STATUS, type TaskJobData } from '@/lib/task/types'

export async function tryEnqueueFrameMergeTask(params: {
  mergeTaskId: string
  locale: string
}): Promise<boolean> {
  const mergeTask = await prisma.task.findUnique({
    where: { id: params.mergeTaskId },
    select: { id: true, status: true, type: true, projectId: true, targetType: true, targetId: true, payload: true, userId: true },
  })

  if (!mergeTask || mergeTask.status !== TASK_STATUS.QUEUED) {
    return false
  }

  const payload = mergeTask.payload as { dependsOn?: string } | null
  const dependsOn = payload?.dependsOn
  if (!dependsOn) {
    return false
  }

  const frameTaskIds = dependsOn.split(',').filter(Boolean)
  if (frameTaskIds.length === 0) {
    return false
  }

  const completedCount = await prisma.task.count({
    where: {
      id: { in: frameTaskIds },
      status: TASK_STATUS.COMPLETED,
    },
  })

  if (completedCount !== frameTaskIds.length) {
    return false
  }

  const updated = await prisma.task.updateMany({
    where: { id: mergeTask.id, status: TASK_STATUS.QUEUED },
    data: { status: TASK_STATUS.PROCESSING },
  })
  if (updated.count === 0) return false

  const jobData: TaskJobData = {
    taskId: mergeTask.id,
    type: mergeTask.type as TaskJobData['type'],
    locale: params.locale as TaskJobData['locale'],
    projectId: mergeTask.projectId,
    targetType: mergeTask.targetType,
    targetId: mergeTask.targetId,
    payload: mergeTask.payload as Record<string, unknown>,
    userId: mergeTask.userId,
  }

  try {
    await addTaskJob(jobData)
    return true
  } catch {
    // Prevent merge task from getting stuck in PROCESSING when enqueue fails.
    await prisma.task.updateMany({
      where: { id: mergeTask.id, status: TASK_STATUS.PROCESSING },
      data: { status: TASK_STATUS.QUEUED },
    })
    return false
  }
}
