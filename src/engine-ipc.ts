import type { LogNote } from 'cortico/core/ipc-logger.ts';
import type { DeferredRendered, EventEnvelope, PushOptions, ToolOutcome, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { GeneralsConfigSection } from './config.ts';

export interface EngineInit {
  cfg: GeneralsConfigSection;
  userId: string;
  timezone: string;
  paused: boolean;
}

export type EngineRequest =
  | { kind: 'init'; init: EngineInit }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; role: string; callId?: string; round?: number }
  | { kind: 'render'; token: number }
  | { kind: 'shutdown' };

export type HostRequest = { kind: 'push'; event: Parameters<WorldHost['pushEvent']>[0]; opts?: PushOptions };

export type EngineNote =
  | LogNote
  | { kind: 'status'; decl: Pick<WorldWebUiDecl, 'lamps' | 'badges' | 'links'>; viewerPort: number | null }
  | { kind: 'deferred'; token: number; spec: Omit<Parameters<WorldHost['pushDeferred']>[0], 'render'>; opts?: Parameters<WorldHost['pushDeferred']>[1] };

export type EngineReply = string | ToolOutcome | DeferredRendered | EventEnvelope | null;

export type MainToChild =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'cancel'; id: number }
  | { t: 'paused'; paused: boolean }
  | { t: 'hrep'; id: number; ok: boolean; value?: unknown; error?: string };

export type ChildToMain =
  | { t: 'rep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'hreq'; id: number; req: HostRequest }
  | { t: 'note'; note: EngineNote };
