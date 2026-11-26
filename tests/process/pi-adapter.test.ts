import { chmod, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import { buildPiArgs } from '../../src/agent/pi/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

interface Recorded {
  argv: string[];
  cwd: string;
  stdin: string;
  systemPromptPath?: string;
  systemPrompt?: string | null;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    PI_CODING_AGENT_DIR?: string;
    APP_SECRET?: string;
  };
}

describe('PiAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(async () => {
    if (oldAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a JSON run with the prompt on stdin and the system prompt in a file', async () => {
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakePi({
      lines: [
        { type: 'session', version: 3, id: 'sess-fresh', cwd: '/tmp' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello user' }],
            stopReason: 'stop',
            usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.001 } },
          },
        },
        { type: 'agent_settled', aborted: false },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      accessMode: 'read-only',
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'sess-fresh', cwd: '/tmp' },
      { type: 'text', delta: 'hello' },
      {
        type: 'usage',
        inputTokens: 3,
        outputTokens: 2,
        cachedInputTokens: 0,
        reasoningOutputTokens: undefined,
        costUsd: 0.001,
      },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', threadId: 'sess-fresh', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(await realpath(record.cwd)).toBe(cwd);
    // The temp system-prompt path differs per run; compare the rest of argv.
    expect(record.argv[0]).toBe('--mode');
    expect(record.argv[1]).toBe('json');
    expect(record.argv[2]).toBe('--append-system-prompt');
    expect(record.argv).toEqual(
      buildPiArgs({
        appendSystemPromptFile: record.argv[3]!,
        accessMode: 'read-only',
      }),
    );
    // Prompt and bridge instructions never travel through argv.
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toBe('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('writes the bridge system prompt to the appended file', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-system-prompt',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });
    await collect(run.events);

    const record = await readRecord(fake.recordPath);
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    // The bridge prompt is not duplicated into the user prompt for Pi.
    expect(record.stdin).toBe('hi');
    // The temp file is removed once the run exits.
    await expect(readFile(record.systemPromptPath!, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('resumes an existing session id through --session-id', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'sess-old',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    const idx = record.argv.indexOf('--session-id');
    expect(idx).toBeGreaterThan(-1);
    expect(record.argv[idx + 1]).toBe('sess-old');
  });

  it('applies the per-run access mode over the adapter default', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      accessMode: 'full',
    }).run({
      runId: 'run-policy-access',
      prompt: 'policy',
      cwd: await realpath(fake.dir),
      accessMode: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--tools');
  });

  it('injects the active bridge profile env', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      larkChannel: { profile: 'pi-dev', rootDir: '/bridge-home' },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'pi-dev',
    });
  });

  it('inherits the user Pi agent dir by default', async () => {
    process.env.PI_CODING_AGENT_DIR = '/outer/pi-agent';
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-inherit',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.PI_CODING_AGENT_DIR).toBe('/outer/pi-agent');
  });

  it('uses a profile-local agent dir only when inheritance is disabled', async () => {
    process.env.PI_CODING_AGENT_DIR = '/outer/pi-agent';
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritAgentDir: false,
    }).run({
      runId: 'run-isolated',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.PI_CODING_AGENT_DIR).toBe(join(fake.dir, 'pi-agent'));
  });

  it('honors a profile-configured agent dir', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_settled', aborted: false }] });
    cleanup.push(fake.dir);
    const agentDir = join(fake.dir, 'custom-pi-agent');

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      agentDir,
    }).run({
      runId: 'run-agent-dir',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-fail' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'sess-fail' },
      { type: 'error', message: 'pi exited with code 42: boom', terminationReason: 'failed' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-pi-${Date.now()}`);
    const run = new PiAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn pi|spawn returned no pid|pi exited with code/,
    );
  });

  it('reports interrupted termination when stopped before settle', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', threadId: 'sess-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'sess-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new PiAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakePi(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  const path = join(dir, 'fake-pi.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      '  const argv = process.argv.slice(2);',
      '  const flag = argv.indexOf("--append-system-prompt");',
      '  let systemPromptPath;',
      '  let systemPrompt = null;',
      '  if (flag !== -1 && argv[flag + 1]) {',
      '    systemPromptPath = argv[flag + 1];',
      '    try { systemPrompt = readFileSync(systemPromptPath, "utf8"); } catch {}',
      '  }',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    systemPromptPath,',
      '    systemPrompt,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<Recorded> {
  return JSON.parse(await readFile(path, 'utf8')) as Recorded;
}
