import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityForProfile,
  claudeCapability,
  codexCapability,
  piCapability,
  usesThreadSession,
} from '../../../src/agent/capability';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });
});

describe('Pi capability', () => {
  it('defines Pi as a system-prompt-injecting, id-resuming agent', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      pi: { binaryPath: '/usr/local/bin/pi' },
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });

    expect(piCapability(profile)).toMatchObject({
      agentId: 'pi',
      sessionKind: 'pi-session',
      promptInjection: 'append-system-prompt',
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      supportsNativeHistory: true,
      callback: { marker: '__bridge_cb', legacyMarkers: [] },
      permissions: { maxAccess: 'workspace' },
    });
  });

  it('routes every agent kind through capabilityForProfile', () => {
    for (const agentKind of ['claude', 'codex', 'pi'] as const) {
      const profile = createDefaultProfileConfig({
        agentKind,
        accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
        ...(agentKind === 'codex' ? { codex: { binaryPath: '/bin/codex' } } : {}),
        ...(agentKind === 'pi' ? { pi: { binaryPath: '/bin/pi' } } : {}),
      });

      expect(capabilityForProfile(profile).agentId).toBe(agentKind);
    }
  });

  it('treats Pi and Codex as thread-based sessions but not Claude', () => {
    const codex = codexCapability(profile('codex'));
    const pi = piCapability(profile('pi'));
    const claude = claudeCapability();

    expect(usesThreadSession(codex)).toBe(true);
    expect(usesThreadSession(pi)).toBe(true);
    expect(usesThreadSession(claude)).toBe(false);
  });
});

function profile(agentKind: 'codex' | 'pi'): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    ...(agentKind === 'codex'
      ? { codex: { binaryPath: '/bin/codex' } }
      : { pi: { binaryPath: '/bin/pi' } }),
  });
}
