import { Queue } from 'bullmq';
import Redis from 'ioredis';

async function main() {
  const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const queue = new Queue('waoowaoo:video', { connection });
  
  const failedJobs = await queue.getFailed(0, 10);
  console.log(`Found ${failedJobs.length} failed jobs in video queue`);
  
  for (const job of failedJobs) {
    if (job.name === 'video_frame_merge' || job.data?.type === 'video_frame_merge' || job.data?.taskId) {
      console.log('--- Failed Job:', job.id);
      console.log('Task ID:', job.data?.taskId);
      console.log('Error:', job.failedReason);
      
      const dependsOn = job.data?.payload?.dependsOn;
      if (dependsOn) {
        const ids = dependsOn.split(',');
        console.log('Depends on length:', ids.length);
        
        // Check for duplicates
        const uniqueIds = new Set(ids);
        if (uniqueIds.size !== ids.length) {
          console.log('DUPLICATE IDS FOUND!');
          const counts: Record<string, number> = {};
          ids.forEach((id: string) => counts[id] = (counts[id] || 0) + 1);
          for (const [id, count] of Object.entries(counts)) {
            if ((count as number) > 1) console.log(`ID ${id} appears ${count} times`);
          }
        }
      }
    }
  }
}

main().finally(() => process.exit(0));
