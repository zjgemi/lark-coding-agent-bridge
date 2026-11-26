import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type PiFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface PiProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

const MAX_TEXT = 4096;

/**
 * Translates Pi's JSONL session events (`--mode json`) into bridge agent events.
 *
 * Relevant shapes (see Pi's `docs/json.md`):
 *  - `{type:'session', id, cwd}`            → the session header (once, first line)
 *  - `message_update` + `assistantMessageEvent` of `text_delta` / `thinking_delta`
 *  - `message_end` with an assistant message → authoritative text + usage
 *  - `tool_execution_start` / `tool_execution_end`
 *  - `agent_settled`                        → the only terminal "no more work" signal
 *  - `auto_retry_*`, `compaction_*`          → progress noise, not terminal
 *
 * `agent_end` is deliberately not terminal: Pi can still retry, recover from
 * overflow, or compact afterwards. Only `agent_settled` means the run is over.
 */
export class PiJsonlTranslator {
  private threadId: string | undefined;
  private terminal = false;
  private lastError: string | undefined;
  private finalText: string | undefined;
  private readonly startedToolCalls = new Set<string>();
  private drift: PiProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'session':
        return this.translateSessionHeader(raw);
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'tool_execution_start':
        return this.translateToolStart(raw);
      case 'tool_execution_end':
        return this.translateToolEnd(raw);
      case 'agent_settled':
        return this.translateAgentSettled(raw);
      case 'auto_retry_start':
        return this.noteRetry(raw);
      case 'auto_retry_end':
        return this.noteRetryEnd(raw);
      // Progress-only records: turns, agent lifecycle, queue/state updates,
      // compaction and direct bash execution carry nothing the bridge renders.
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'tool_execution_update':
      case 'queue_update':
      case 'entry_appended':
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'compaction_start':
      case 'compaction_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { agent: 'pi', eventType: raw.type });
        return [];
    }
  }

  /** Tail handling when the process ends without `agent_settled`. */
  finish(reason: PiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    if (reason === 'failed') {
      const detail = this.lastError ? `: ${this.lastError}` : '';
      return this.fail(`pi stream ended before a terminal event${detail}`);
    }
    this.terminal = true;
    const events: AgentEvent[] = [];
    if (this.finalText) {
      events.push({ type: 'final_text', content: this.finalText });
    }
    events.push({
      type: 'done',
      ...(this.threadId ? { threadId: this.threadId } : {}),
      terminationReason: reason,
    });
    return events;
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message: truncate(message, MAX_TEXT), terminationReason: 'failed' }];
  }

  protocolDrift(): PiProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateSessionHeader(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    this.threadId = id;
    const cwd = stringValue(raw.cwd);
    return [{ type: 'system', threadId: id, ...(cwd ? { cwd } : {}) }];
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const update = recordValue(raw.assistantMessageEvent);
    if (!update) {
      this.drift.anomalies++;
      return [];
    }
    switch (update.type) {
      case 'text_delta': {
        const delta = stringValue(update.delta);
        return delta ? [{ type: 'text', delta }] : [];
      }
      case 'thinking_delta': {
        const delta = stringValue(update.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'error': {
        // Provider-stream failures are surfaced by the terminal path (settle or
        // the message_end that follows); remember the reason for the report.
        const message = streamErrorMessage(update);
        if (message) this.lastError = message;
        return [];
      }
      default:
        // start / text_start / text_end / thinking_* / toolcall_* — the
        // authoritative content arrives via message_end and tool_execution_*.
        return [];
    }
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(raw.message);
    if (!message || message.role !== 'assistant') return [];

    const stopReason = stringValue(message.stopReason);
    if (stopReason === 'error') {
      const message_ = stringValue(message.errorMessage);
      if (message_) this.lastError = message_;
      this.drift.anomalies++;
      return [];
    }
    if (stopReason === 'aborted') {
      // Stopped mid-turn: keep whatever text it produced, but the settle event
      // reports the interruption.
      const text = assistantText(message);
      if (text) this.finalText = text;
      return [];
    }

    // Each assistant turn's completed text supersedes the previous turn's, so
    // the last message before settling is the run's final answer.
    const text = assistantText(message);
    if (text) this.finalText = text;

    const usage = recordValue(message.usage);
    return usage ? [usageEvent(usage)] : [];
  }

  private translateToolStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    this.startedToolCalls.add(id);
    return [
      {
        type: 'tool_use',
        id,
        name: stringValue(raw.toolName) ?? 'tool',
        input: raw.args,
      },
    ];
  }

  private translateToolEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (this.startedToolCalls.delete(id) === false) {
      this.drift.anomalies++;
    }
    return [
      {
        type: 'tool_result',
        id,
        output: toolResultText(raw.result),
        isError: raw.isError === true,
      },
    ];
  }

  private translateAgentSettled(raw: Record<string, unknown>): AgentEvent[] {
    if (raw.aborted === true) {
      this.terminal = true;
      return [
        {
          type: 'done',
          ...(this.threadId ? { threadId: this.threadId } : {}),
          terminationReason: 'interrupted',
        },
      ];
    }
    // Nothing usable came out of the run and the last thing Pi reported was a
    // failure: settle is the terminal error. `fail()` marks the stream terminal.
    if (this.lastError && !this.finalText) {
      return this.fail(`pi run failed: ${this.lastError}`);
    }
    this.terminal = true;
    const events: AgentEvent[] = [];
    if (this.finalText) {
      events.push({ type: 'final_text', content: this.finalText });
    }
    events.push({
      type: 'done',
      ...(this.threadId ? { threadId: this.threadId } : {}),
      terminationReason: 'normal',
    });
    return events;
  }

  private noteRetry(raw: Record<string, unknown>): AgentEvent[] {
    const message = stringValue(raw.errorMessage);
    if (message) {
      this.lastError = message;
      log.warn('jsonl', 'auto_retry', { agent: 'pi', message: truncate(message, 500) });
    }
    return [];
  }

  private noteRetryEnd(raw: Record<string, unknown>): AgentEvent[] {
    if (raw.success === false) {
      const message = stringValue(raw.finalError) ?? this.lastError;
      if (message) this.lastError = message;
    } else {
      // A successful retry clears the transient provider failure.
      this.lastError = undefined;
    }
    return [];
  }
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  const cost = recordValue(usage.cost);
  return {
    type: 'usage',
    inputTokens: numberValue(usage.input),
    outputTokens: numberValue(usage.output),
    cachedInputTokens: numberValue(usage.cacheRead),
    reasoningOutputTokens: numberValue(usage.reasoning),
    ...(cost ? { costUsd: numberValue(cost.total) } : {}),
  };
}

/** Concatenated `text` blocks of an assistant message. */
function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => stringValue(block.text) ?? '')
    .join('');
}

/** Flatten a tool result's content blocks into the text the card renders. */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const record = recordValue(result);
  if (!record) return '';
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return safeStringify(record);
  }
  const parts = content.filter(isRecord).map((block) => {
    if (block.type === 'text') return stringValue(block.text) ?? '';
    if (block.type === 'image') return '[image]';
    return safeStringify(block);
  });
  return parts.join('\n');
}

function streamErrorMessage(update: Record<string, unknown>): string | undefined {
  const nested = recordValue(update.error);
  return (
    stringValue(update.reason) ??
    stringValue(nested?.message) ??
    stringValue(update.error) ??
    undefined
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
