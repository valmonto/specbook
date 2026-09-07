import { describe, expect, it } from 'vitest';
import { CancelDeploymentRequestSchema, DEPLOYMENT_STATUSES } from '../src/index.js';

describe('cancelled is a first-class terminal state', () => {
  /**
   * Not folded into 'failed'. A cancel means nothing was wrong — someone
   * changed their mind, or pushed the wrong commit. Conflating the two makes a
   * deploy history unreadable and hides real failures among the changed minds.
   */
  it('is distinct from failed', () => {
    expect(DEPLOYMENT_STATUSES).toContain('cancelled');
    expect(DEPLOYMENT_STATUSES).toContain('failed');
  });

  it('addresses the ENVIRONMENT, not a deployment id', () => {
    // Only one run is ever in flight, and whoever is cancelling is looking at
    // the environment — not at a run whose id they happen to hold.
    const parsed = CancelDeploymentRequestSchema.parse({
      projectId: '11111111-1111-4111-8111-111111111111',
      id: '22222222-2222-4222-8222-222222222222',
    });
    expect(parsed.id).toBeDefined();
  });

  it('rejects unknown fields, like every other request', () => {
    const result = CancelDeploymentRequestSchema.safeParse({
      projectId: '11111111-1111-4111-8111-111111111111',
      id: '22222222-2222-4222-8222-222222222222',
      deploymentId: '33333333-3333-4333-8333-333333333333',
    });
    expect(result.success).toBe(false);
  });
});
