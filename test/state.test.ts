import { describe, it, expect } from 'vitest';
import { agentCommand, buildWorkerPlans } from '../extensions/gaud/index.js';
import type { GaudRunState } from '../extensions/gaud/index.js';

describe('State Serialization', () => {
  it('should serialize and deserialize a GaudRunState object correctly', () => {
    const run: GaudRunState = {
      id: 'gaud-123',
      status: 'running',
      task: 'implement feature',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      repoRoot: '/root',
      runDir: '/root/.gaud/runs/gaud-123',
      eventsPath: '/root/.gaud/runs/gaud-123/events.jsonl',
      statePath: '/root/.gaud/runs/gaud-123/state.json',
      tmuxSocket: 'gaud-123',
      tmuxSession: 'gaud-123',
      workers: {},
      lastEventOffset: 0,
    };

    const json = JSON.stringify(run);
    const deserialized = JSON.parse(json) as GaudRunState;

    expect(deserialized.id).toBe(run.id);
    expect(deserialized.status).toBe(run.status);
    expect(deserialized.task).toBe(run.task);
  });
});

describe('Polling Bridge - Event Parsing', () => {
  it('should parse valid callback events from a JSONL string', () => {
    const eventsJsonl = [
      JSON.stringify({ ts: Date.now(), runId: 'gaud-123', workerId: 'frontend', type: 'done', summary: 'Implemented UI' }),
      JSON.stringify({ ts: Date.now(), runId: 'gaud-123', workerId: 'backend', type: 'waiting-user', question: 'Confirm API' }),
    ].join('\n');

    const lines = eventsJsonl.split('\n');
    const parsedEvents = lines.map(line => JSON.parse(line));

    expect(parsedEvents).toHaveLength(2);
    expect(parsedEvents[0].workerId).toBe('frontend');
    expect(parsedEvents[0].type).toBe('done');
    expect(parsedEvents[1].workerId).toBe('backend');
    expect(parsedEvents[1].type).toBe('waiting-user');
  });
});

describe('Agent command generation', () => {
  it('uses Codex exec instead of piping stdin into the interactive TUI', () => {
    const command = agentCommand('codex', 'codex', '/tmp/prompt.txt', false);

    expect(command).toContain('codex');
    expect(command).toContain('exec');
    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(command).not.toContain('< <(');
  });

  it('uses Gemini headless YOLO mode instead of interactive positional prompt', () => {
    const command = agentCommand('gemini', 'gemini', '/tmp/prompt.txt', false);

    expect(command).toContain('gemini');
    expect(command).toContain('--yolo');
    expect(command).toContain('--prompt');
  });

  it('uses OpenCode non-interactive auto-approval and an automatic callback fallback', () => {
    const command = agentCommand('opencode', 'opencode', '/tmp/prompt.txt', false);

    expect(command).toContain('opencode');
    expect(command).toContain('run');
    expect(command).toContain('--dangerously-skip-permissions');
    expect(command).toContain('completed without explicit callback');
  });

  it('uses Antigravity print mode instead of unsupported run subcommand', () => {
    const command = agentCommand('agy', 'agy', '/tmp/prompt.txt', false);

    expect(command).toContain('agy');
    expect(command).toContain('--print');
    expect(command).toContain('--dangerously-skip-permissions');
    expect(command).not.toContain(' run ');
  });
});

describe('Worker plan generation', () => {
  it('keeps implementer assignments as implementers when plan text mentions review', () => {
    const plans = buildWorkerPlans('Design and code review methodology context', 'review the UX and implement the fix', {
      'gaud-design': 'gemini',
      'gaud-eng': 'claude',
      'gaud-implementer': ['opencode'],
      'gaud-code-review': 'claude',
    });

    expect(plans.map((plan) => plan.role)).toEqual([
      'gaud-design',
      'gaud-eng',
      'gaud-implementer',
      'gaud-code-review',
    ]);
    expect(plans[2]?.id).toBe('gaud-implementer-3');
  });
});
