import Bull from 'bull';
import documentIngestionService from './documentIngestionService';

interface DocumentProcessingJob {
  materialId: string;
  startPage?: number;
  maxPages?: number;
}

class JobQueueService {
  private documentQueue: Bull.Queue<DocumentProcessingJob>;

  constructor() {
    try {
      // Create job queue with Redis connection
      this.documentQueue = new Bull('document processing', {
        redis: {
          port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
          host: process.env.REDIS_HOST || 'localhost',
          // If no Redis configured, Bull will handle gracefully
        },
        defaultJobOptions: {
          removeOnComplete: 10, // Keep last 10 completed jobs
          removeOnFail: 50,     // Keep last 50 failed jobs
          attempts: 3,          // Retry failed jobs up to 3 times
          backoff: {
            type: 'exponential',
            delay: 10000,       // Start with 10 second delay
          },
        },
      });

      this.setupJobProcessors();
      this.setupJobEventHandlers();
      console.log('✅ Job queue initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize job queue:', error);
      throw error;
    }
  }

  private setupJobProcessors(): void {
    // Process document ingestion jobs
    this.documentQueue.process('process-document', 1, async (job) => {
      const { materialId, startPage, maxPages } = job.data;
      
      console.log(`Starting document processing job for material: ${materialId} (startPage: ${startPage}, maxPages: ${maxPages})`);
      
      try {
        await documentIngestionService.processDocument(materialId, startPage, maxPages);
        console.log(`Document processing completed for material: ${materialId}`);
        return { success: true, materialId, startPage, maxPages };
      } catch (error) {
        console.error(`Document processing failed for material ${materialId}:`, error);
        throw error;
      }
    });
  }

  private setupJobEventHandlers(): void {
    // Job completed successfully
    this.documentQueue.on('completed', (job, result) => {
      console.log(`Job ${job.id} completed successfully:`, result);
    });

    // Job failed
    this.documentQueue.on('failed', (job, error) => {
      console.error(`Job ${job.id} failed:`, error.message);
    });

    // Job progress update
    this.documentQueue.on('progress', (job, progress) => {
      console.log(`Job ${job.id} progress: ${progress}%`);
    });

    // Queue stalled
    this.documentQueue.on('stalled', (job) => {
      console.warn(`Job ${job.id} stalled and will be retried`);
    });
  }

  async addDocumentProcessingJob(materialId: string, startPage?: number, maxPages?: number): Promise<Bull.Job<DocumentProcessingJob>> {
    try {
      const job = await this.documentQueue.add(
        'process-document',
        { materialId, startPage, maxPages },
        {
          priority: 1,
          delay: 1000, // Start processing after 1 second
        }
      );

      console.log(`Added document processing job for material: ${materialId}, Job ID: ${job.id} (startPage: ${startPage}, maxPages: ${maxPages})`);
      return job;
    } catch (error) {
      console.error('Error adding document processing job:', error);
      throw error;
    }
  }

  async getJobStatus(jobId: string): Promise<any> {
    try {
      const job = await this.documentQueue.getJob(jobId);
      if (!job) {
        return null;
      }

      return {
        id: job.id,
        data: job.data,
        progress: job.progress(),
        state: await job.getState(),
        createdAt: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
      };
    } catch (error) {
      console.error('Error getting job status:', error);
      throw error;
    }
  }

  async getActiveJobs(): Promise<Bull.Job[]> {
    try {
      return await this.documentQueue.getActive();
    } catch (error) {
      console.error('Error getting active jobs:', error);
      return [];
    }
  }

  async getWaitingJobs(): Promise<Bull.Job[]> {
    try {
      return await this.documentQueue.getWaiting();
    } catch (error) {
      console.error('Error getting waiting jobs:', error);
      return [];
    }
  }

  async getFailedJobs(): Promise<Bull.Job[]> {
    try {
      return await this.documentQueue.getFailed();
    } catch (error) {
      console.error('Error getting failed jobs:', error);
      return [];
    }
  }

  async retryFailedJob(jobId: string): Promise<void> {
    try {
      const job = await this.documentQueue.getJob(jobId);
      if (job) {
        await job.retry();
        console.log(`Retrying job: ${jobId}`);
      }
    } catch (error) {
      console.error('Error retrying job:', error);
      throw error;
    }
  }

  async removeJob(jobId: string): Promise<void> {
    try {
      const job = await this.documentQueue.getJob(jobId);
      if (job) {
        await job.remove();
        console.log(`Removed job: ${jobId}`);
      }
    } catch (error) {
      console.error('Error removing job:', error);
      throw error;
    }
  }

  async getQueueStats(): Promise<any> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.documentQueue.getWaiting(),
        this.documentQueue.getActive(),
        this.documentQueue.getCompleted(),
        this.documentQueue.getFailed(),
        this.documentQueue.getDelayed(),
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
      };
    } catch (error) {
      console.error('Error getting queue stats:', error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      };
    }
  }

  async cleanQueue(): Promise<void> {
    try {
      // Clean old completed and failed jobs
      await this.documentQueue.clean(24 * 60 * 60 * 1000, 'completed'); // 24 hours
      await this.documentQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'); // 7 days
      console.log('Queue cleaned successfully');
    } catch (error) {
      console.error('Error cleaning queue:', error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.documentQueue.close();
      console.log('Job queue closed');
    } catch (error) {
      console.error('Error closing job queue:', error);
    }
  }
}

export default new JobQueueService();