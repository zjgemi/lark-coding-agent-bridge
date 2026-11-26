import { describe, expect, it } from 'vitest';
import { PI_READ_ONLY_TOOLS, buildPiArgs } from '../../../src/agent/pi/argv.js';

const SYSTEM_PROMPT = '/tmp/lark-pi-abc/append-system-prompt.md';

describe('Pi argv contract', () => {
  it('builds a one-shot JSON run with the system prompt from a file', () => {
    expect(buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'full' })).toEqual([
      '--mode',
      'json',
      '--append-system-prompt',
      SYSTEM_PROMPT,
      '-a',
    ]);
  });

  it('never puts a prompt in argv (prompt travels on stdin)', () => {
    const args = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'full' });
    expect(args).not.toContain('--print');
    expect(args.every((arg) => !arg.includes('<bridge_context>'))).toBe(true);
  });

  it('enforces read-only access with a tool allowlist that drops mutating tools', () => {
    const args = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'read-only' });
    const toolsIdx = args.indexOf('--tools');

    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe(PI_READ_ONLY_TOOLS.join(','));
    for (const mutating of ['bash', 'edit', 'write']) {
      expect(args[toolsIdx + 1]?.split(',')).not.toContain(mutating);
    }
  });

  it('does not restrict tools for workspace or full access', () => {
    for (const accessMode of ['workspace', 'full'] as const) {
      const args = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode });
      expect(args).not.toContain('--tools');
    }
  });

  it('resumes an existing session by id', () => {
    const args = buildPiArgs({
      appendSystemPromptFile: SYSTEM_PROMPT,
      accessMode: 'workspace',
      threadId: '5b1a2c3d-0000-4000-8000-abcdefabcdef',
    });
    const idx = args.indexOf('--session-id');

    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('5b1a2c3d-0000-4000-8000-abcdefabcdef');
  });

  it('omits --session-id for a fresh run', () => {
    const args = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'workspace' });
    expect(args).not.toContain('--session-id');
  });

  it('forwards the selected model and omits it when unset', () => {
    const withModel = buildPiArgs({
      appendSystemPromptFile: SYSTEM_PROMPT,
      accessMode: 'full',
      model: 'anthropic/claude-sonnet-4-5',
    });
    const idx = withModel.indexOf('--model');
    expect(withModel[idx + 1]).toBe('anthropic/claude-sonnet-4-5');

    const withoutModel = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'full' });
    expect(withoutModel).not.toContain('--model');
  });

  it('trusts project resources by default and can be told not to', () => {
    const trusted = buildPiArgs({ appendSystemPromptFile: SYSTEM_PROMPT, accessMode: 'full' });
    expect(trusted).toContain('-a');
    expect(trusted).not.toContain('--no-approve');

    const untrusted = buildPiArgs({
      appendSystemPromptFile: SYSTEM_PROMPT,
      accessMode: 'full',
      approveProject: false,
    });
    expect(untrusted).toContain('--no-approve');
    expect(untrusted).not.toContain('-a');
  });
});
