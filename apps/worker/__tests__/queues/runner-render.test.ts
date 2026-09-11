import { describe, expect, it } from 'vitest';
import { renderRunnerMcpJson, renderRunnerPrompt } from '@/queues/agent-lifecycle/runner-render.js';

describe('renderRunnerMcpJson', () => {
  it('points the specbook server at /api/mcp with the bearer key', () => {
    const out = JSON.parse(renderRunnerMcpJson('https://specbook.example.com', 'sk_abc'));
    expect(out.mcpServers.specbook.url).toBe('https://specbook.example.com/api/mcp');
    expect(out.mcpServers.specbook.headers.Authorization).toBe('Bearer sk_abc');
    expect(out.mcpServers.specbook.type).toBe('http');
  });

  it('tolerates a trailing slash on the base URL', () => {
    const out = JSON.parse(renderRunnerMcpJson('https://s.example.com/', 'sk_x'));
    expect(out.mcpServers.specbook.url).toBe('https://s.example.com/api/mcp');
  });
});

describe('renderRunnerPrompt', () => {
  const prompt = renderRunnerPrompt('runner-2');

  it('names the agent and mandates the heartbeat + sweep loop', () => {
    expect(prompt).toContain('"runner-2"');
    expect(prompt).toContain('heartbeat');
    expect(prompt).toContain('sleep 300');
  });

  /**
   * The harness refuses a foreground `sleep`. The prompt used to say "run
   * `sleep 300` in Bash", so every managed agent hit that refusal on every
   * empty sweep and then tried to smuggle it past with `sleep 300; echo ...`
   * — the workaround the refusal explicitly names. Observed live on a real
   * runner, in its own log.
   */
  it('paces with a BACKGROUND sleep, the only form the harness allows', () => {
    expect(prompt).toContain('run_in_background: true');
    expect(prompt).toMatch(/FOREGROUND[\s\S]*refused/);
    // and warns off the disguise the agent actually attempted
    expect(prompt).toContain('chaining shorter sleeps');
  });

  it('carries the hard lines: no draft/ready/approved/done transitions', () => {
    expect(prompt).toContain('Never touch draft tasks');
    expect(prompt).toContain('ready, approved or done');
  });

  it('contains no secrets — the key lives only in .mcp.json', () => {
    // \bsk_ + 8 word chars = key-shaped; `update_task_links` is not.
    expect(prompt).not.toMatch(/\bsk_[A-Za-z0-9]{8}/);
    expect(prompt).not.toContain('Bearer');
  });
});
