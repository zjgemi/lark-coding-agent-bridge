import type { AccessMode } from '../../config/permissions';

export interface BuildPiArgsInput {
  /** Path to the temp file holding the bridge system prompt to append. */
  appendSystemPromptFile: string;
  /**
   * Policy access mode. Pi has no sandbox switch, so a read-only run is
   * enforced with a tool allowlist that drops every mutating built-in tool
   * (`bash`, `edit`, `write`) while keeping the read-only inspection tools.
   */
  accessMode: AccessMode;
  /** Existing Pi session id to resume; omitted starts a fresh session. */
  threadId?: string;
  /** Forwarded to `--model`. Omitted leaves Pi on its configured default. */
  model?: string;
  /** Trust project-local config/resources for this run (`-a`). */
  approveProject?: boolean;
}

/**
 * Tools left to a read-only run. Pi's default selection is
 * `read,bash,edit,write`, so this is the same inspection surface minus the
 * mutating entries.
 */
export const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/**
 * Build argv for one one-shot Pi run.
 *
 * The prompt is NOT part of argv: Pi prepends piped stdin to the first prompt,
 * which keeps every `<bridge_context>` character away from the shell (the same
 * reason the claude and codex adapters pass the prompt on stdin).
 *
 * `--mode json` both selects the JSONL event stream and forces one-shot
 * execution, so no `--print` is needed.
 */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args = [
    '--mode',
    'json',
    '--append-system-prompt',
    input.appendSystemPromptFile,
    input.approveProject === false ? '--no-approve' : '-a',
  ];
  if (input.accessMode === 'read-only') {
    args.push('--tools', PI_READ_ONLY_TOOLS.join(','));
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.threadId) {
    args.push('--session-id', input.threadId);
  }
  return args;
}
