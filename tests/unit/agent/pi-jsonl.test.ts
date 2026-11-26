import { describe, expect, it } from 'vitest';
import { PiJsonlTranslator } from '../../../src/agent/pi/jsonl.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function translateAll(lines: unknown[]): AgentEvent[] {
  const translator = new PiJsonlTranslator();
  return lines.flatMap((line) => translator.translate(line));
}

describe('Pi JSONL translator', () => {
  it('reports the session header as a system event carrying the resumable id', () => {
    expect(
      translateAll([
        { type: 'session', version: 3, id: 'sess-1', timestamp: '2024-12-03T14:00:00.000Z', cwd: '/repo' },
      ]),
    ).toEqual([{ type: 'system', threadId: 'sess-1', cwd: '/repo' }]);
  });

  it('streams text and thinking deltas as they arrive', () => {
    expect(
      translateAll([
        {
          type: 'message_update',
          usage: { input: 10, output: 1 },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'pondering' },
        },
      ]),
    ).toEqual([
      { type: 'text', delta: 'Hello ' },
      { type: 'thinking', delta: 'pondering' },
    ]);
  });

  it('translates tool execution lifecycle into tool_use / tool_result', () => {
    expect(
      translateAll([
        {
          type: 'tool_execution_start',
          toolCallId: 'call_1',
          toolName: 'bash',
          args: { command: 'ls -la' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'total 48' }], details: {} },
          isError: false,
          durationMs: 12,
        },
      ]),
    ).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls -la' } },
      { type: 'tool_result', id: 'call_1', output: 'total 48', isError: false },
    ]);
  });

  it('marks failing tool results as errors and keeps image blocks readable', () => {
    expect(
      translateAll([
        { type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'read', args: {} },
        {
          type: 'tool_execution_end',
          toolCallId: 'call_2',
          toolName: 'read',
          result: {
            content: [
              { type: 'text', text: 'ENOENT' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
          isError: true,
        },
      ])[1],
    ).toEqual({ type: 'tool_result', id: 'call_2', output: 'ENOENT\n[image]', isError: true });
  });

  it('emits usage and the authoritative final text at settle', () => {
    expect(
      translateAll([
        { type: 'session', id: 'sess-2', cwd: '/repo' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'par' },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial answer' }],
            stopReason: 'stop',
            usage: {
              input: 100,
              output: 20,
              cacheRead: 5,
              cacheWrite: 0,
              reasoning: 7,
              totalTokens: 120,
              cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
            },
          },
        },
        { type: 'agent_end', messages: [], willRetry: false },
        { type: 'agent_settled', aborted: false },
      ]),
    ).toEqual([
      { type: 'system', threadId: 'sess-2', cwd: '/repo' },
      { type: 'text', delta: 'par' },
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 5,
        reasoningOutputTokens: 7,
        costUsd: 0.03,
      },
      { type: 'final_text', content: 'partial answer' },
      { type: 'done', threadId: 'sess-2', terminationReason: 'normal' },
    ]);
  });

  it('prefers the newest assistant turn as the final answer', () => {
    const events = translateAll([
      { type: 'session', id: 'sess-3' },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'toolUse' },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }], stopReason: 'stop' },
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([
      { type: 'final_text', content: 'second' },
    ]);
  });

  it('does not treat agent_end as terminal (retries can still follow)', () => {
    const translator = new PiJsonlTranslator();
    translator.translate({ type: 'agent_end', messages: [], willRetry: true });
    expect(translator.terminalEmitted()).toBe(false);
  });

  it('reports an interrupted termination when the run is aborted', () => {
    expect(translateAll([{ type: 'agent_settled', aborted: true }])).toEqual([
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });

  it('treats a final retry failure as a run error', () => {
    const events = translateAll([
      { type: 'session', id: 'sess-4' },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: '529 overloaded' },
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(events).toEqual([
      { type: 'system', threadId: 'sess-4' },
      { type: 'error', message: 'pi run failed: 529 overloaded', terminationReason: 'failed' },
    ]);
  });

  it('clears the transient error once a retry succeeds', () => {
    const events = translateAll([
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'terminated' },
      { type: 'auto_retry_end', success: true, attempt: 2 },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' },
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(events).toEqual([
      { type: 'final_text', content: 'recovered' },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores progress-only records and counts unknown ones as protocol drift', () => {
    const translator = new PiJsonlTranslator();
    expect(
      translator.translate({ type: 'turn_start' }),
    ).toEqual([]);
    expect(
      translator.translate({ type: 'message_start', message: { role: 'user', content: 'hi' } }),
    ).toEqual([]);
    expect(translator.translate({ type: 'brand_new_event' })).toEqual([]);
    expect(translator.protocolDrift().unknownEvents).toBe(1);
    expect(translator.protocolDrift().anomalies).toBe(0);
  });

  it('reports a failed stream when no terminal event ever arrives', () => {
    const translator = new PiJsonlTranslator();
    translator.translate({ type: 'session', id: 'sess-5' });
    expect(translator.finish()).toEqual([
      {
        type: 'error',
        message: 'pi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(translator.terminalEmitted()).toBe(true);
  });

  it('finishes an interrupted stream with the text seen so far', () => {
    const translator = new PiJsonlTranslator();
    translator.translate({ type: 'session', id: 'sess-6' });
    translator.translate({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'so far' }], stopReason: 'stop' },
    });
    expect(translator.finish('interrupted')).toEqual([
      { type: 'final_text', content: 'so far' },
      { type: 'done', threadId: 'sess-6', terminationReason: 'interrupted' },
    ]);
  });

  it('emits nothing more once a terminal event has been produced', () => {
    const translator = new PiJsonlTranslator();
    translator.translate({ type: 'agent_settled', aborted: false });
    expect(translator.translate({ type: 'agent_settled', aborted: false })).toEqual([]);
    expect(translator.fail('late failure')).toEqual([]);
  });
});
