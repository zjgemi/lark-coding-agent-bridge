import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'pi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Pi resumes by session id (`--session-id`), keeps the transcript in its own
 * agent dir, and takes the bridge system prompt through
 * `--append-system-prompt <path>` (so special characters never reach argv).
 */
export function piCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'pi',
    sessionKind: 'pi-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * The single place that maps a profile's agent kind to its capability, so
 * callers never have to re-derive it with a ternary (and can't forget a new
 * agent kind when one is added).
 */
export function capabilityForProfile(profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>): AgentCapability {
  switch (profile.agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'pi':
      return piCapability(profile);
    case 'claude':
      return claudeCapability(profile);
  }
}

/**
 * True when the agent identifies its resumable conversation by a thread/session
 * id stored on the session catalog (`codex`, `pi`) rather than by Claude Code's
 * session-id store. Those agents resume through `AgentRunOptions.threadId`.
 */
export function usesThreadSession(
  capability: Pick<AgentCapability, 'sessionKind'>,
): boolean {
  return capability.sessionKind !== 'claude-session';
}
