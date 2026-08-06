import { describe, expect, it } from 'vitest';
import {
  renderRunnerMcpJson,
  renderRunnerPrompt,
} from '../../../src/modules/deploy/runner-render';

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
