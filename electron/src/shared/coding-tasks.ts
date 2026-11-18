import { z } from 'zod';

export const codingTaskStartSchema = z.object({
  repository: z.string().min(1).max(4096),
  instruction: z.string().trim().min(1).max(6000),
  verificationCommand: z.string().trim().min(1).max(500),
}).strict();

export const codingTaskIdSchema = z.string().uuid();
export type CodingTaskInput = z.infer<typeof codingTaskStartSchema>;
export type CodingTaskStatus = 'preparing' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface CodingVerification {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface CodingTask extends CodingTaskInput {
  id: string;
  workspace: string;
  status: CodingTaskStatus;
  sessionId: string | null;
  summary: string;
  output: string;
  diff: string;
  diffTruncated: boolean;
  error: string | null;
  verification: CodingVerification | null;
  createdAt: string;
  updatedAt: string;
}
