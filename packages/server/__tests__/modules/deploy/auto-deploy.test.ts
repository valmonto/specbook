import { describe, expect, it } from 'vitest';
import { computeAutoDeployPaused } from '../../../src/modules/deploy/auto-deploy.js';

const failedAuto = { status: 'failed', trigger: 'auto' };
const failedManual = { status: 'failed', trigger: 'manual' };
const healthy = (trigger: string) => ({ status: 'healthy', trigger });

describe('computeAutoDeployPaused (newest-first)', () => {
  it('trips only on two consecutive-ish auto failures', () => {
    expect(computeAutoDeployPaused([])).toBe(false);
    expect(computeAutoDeployPaused([failedAuto])).toBe(false);
    expect(computeAutoDeployPaused([failedAuto, failedAuto])).toBe(true);
  });

  it('any success — manual or auto — resets the breaker', () => {
    expect(computeAutoDeployPaused([healthy('manual'), failedAuto, failedAuto])).toBe(false);
    expect(computeAutoDeployPaused([healthy('auto'), failedAuto, failedAuto])).toBe(false);
  });

  it('manual failures neither count nor reset', () => {
    expect(computeAutoDeployPaused([failedManual, failedAuto])).toBe(false);
    expect(computeAutoDeployPaused([failedAuto, failedManual, failedAuto])).toBe(true);
  });

  it('an in-flight run defers judgement', () => {
    expect(computeAutoDeployPaused([{ status: 'building', trigger: 'auto' }, failedAuto, failedAuto])).toBe(false);
  });
});
