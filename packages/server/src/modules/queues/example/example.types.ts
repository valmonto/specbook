/**
 * Payload for example queue jobs.
 * This is what gets passed to the processor.
 */
export interface ExampleJobPayload {
  /** The session user the job is attributed to — never taken from a request payload */
  userId: string;
  /** The organization the job was enqueued from, so processors can scope their work */
  orgId: string;
  /** Action to perform. `research-turn` is the async agent research turn
   *  enqueued when a research message is appended — the processor is a stub
   *  today (the research worker is not yet built); see docs/product-design.md. */
  action: 'send-email' | 'generate-report' | 'sync-data' | 'research-turn';
  /** Additional data for the job */
  data: Record<string, unknown>;
}

/**
 * Result returned by the processor after job completion.
 */
export interface ExampleJobResult {
  success: boolean;
  processedAt: string;
  message?: string;
}

/**
 * Job names for type-safe job creation.
 */
export const EXAMPLE_JOB_NAMES = {
  PROCESS: 'process',
} as const;
