import { fileURLToPath } from 'node:url';
import type { GeneralsConfigSection } from '../config.ts';
import type { AgentDecision, AgentObservation, AgentTaskKind, StrategyIntentState } from './contracts.ts';
import type { StrategyFeedback } from './strategy.ts';
import { PythonChannel } from './python-channel.ts';

export const CITY_HALF_IMPLEMENTATION = 'harris@71e6b58:bot_blob+s2-city-half/1';
const SCRIPT = fileURLToPath(new URL('./city-half/adapter.py', import.meta.url));
const TASKS: Record<string, AgentTaskKind> = { auto: 'auto', expand: 'expand', capture_city: 'capture_city',
  gather: 'gather', defend: 'defend', scout: 'scout', attack_general: 'capture_general', capture_general: 'capture_general' };

/** Owns one Python policy instance per game/control epoch. No game sockets or model calls. */
export class CityHalfAgent {
  private channel: PythonChannel | null = null;
  private session: string | null = null;
  private readonly closing = new Set<Promise<void>>();

  constructor(private readonly options: GeneralsConfigSection['agent']) {}

  reset(): void {
    this.session = null;
    if (!this.channel) return;
    const closed = this.channel.close();
    this.channel = null;
    this.closing.add(closed);
    void closed.finally(() => this.closing.delete(closed));
  }

  async close(): Promise<void> { this.reset(); await Promise.all(this.closing); }

  async decide(observation: AgentObservation, strategy: StrategyIntentState): Promise<{ decision: AgentDecision; feedback: StrategyFeedback | null }> {
    const playerCount = Math.max(observation.generals.length, observation.playerIndex + 1,
      ...(observation.playerLifecycle ?? []).map((player) => player.player + 1));
    const generals = Array.from({ length: playerCount }, (_, player) => observation.generals[player] ?? -1);
    const key = JSON.stringify([observation.gameId, observation.controlEpoch]);
    if (key !== this.session) {
      this.reset();
      this.session = key;
      this.channel = new PythonChannel(this.options.pythonExecutable, SCRIPT, this.options.pythonTimeoutMs);
      const ready = await this.channel.request({ kind: 'init', gameId: observation.gameId,
        controlEpoch: observation.controlEpoch, width: observation.width, height: observation.height,
        playerIndex: observation.playerIndex, playerCount, seed: 0 });
      if (ready.ready !== true || ready.implementation !== CITY_HALF_IMPLEMENTATION) throw new Error('Unexpected city-half-1 implementation');
    }
    const channel = this.channel;
    if (!channel || this.session !== key) throw new Error('City-half-1 session invalidated');
    const reply = await channel.request({ kind: 'step',
      context: { gameId: observation.gameId, controlEpoch: observation.controlEpoch, revision: observation.revision }, strategy,
      observation: { width: observation.width, height: observation.height, playerIndex: observation.playerIndex,
        playerCount, turn: observation.turn,
        // Fog remains unknown; only the Python Map's dated structural cache remembers it.
        terrain: observation.tiles.map((tile) => tile.terrain), armies: observation.tiles.map((tile) => tile.armies ?? 0),
        cities: observation.cities ?? observation.tiles.filter((tile) => tile.city).map((tile) => tile.index),
        generals, scores: observation.scores } });
    return decodeCityHalfReply(reply, observation);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid city-half-1 response object');
  return value as Record<string, unknown>;
}

/** Validate the subprocess boundary before a decision can reach the common move executor. */
export function decodeCityHalfReply(reply: Record<string, unknown>, observation: AgentObservation): { decision: AgentDecision; feedback: StrategyFeedback | null } {
  const task = object(reply.task), diagnostics = object(reply.diagnostics);
  const tile = (value: unknown): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= observation.tiles.length) throw new Error('Invalid city-half-1 tile');
    return value as number;
  };
  const kind = TASKS[String(task.kind)];
  if (!kind || typeof task.phase !== 'string' || typeof diagnostics.mode !== 'string'
    || !Array.isArray(task.allocatedTiles) || typeof reply.computeMs !== 'number' || !Number.isFinite(reply.computeMs) || reply.computeMs < 0) {
    throw new Error('Invalid city-half-1 task or timing');
  }
  let feedback: StrategyFeedback | null = null;
  if (reply.strategyFeedback !== null) {
    const value = object(reply.strategyFeedback);
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.reason !== 'string'
      || !['following', 'preempted', 'blocked', 'completed'].includes(String(value.status))) throw new Error('Invalid city-half-1 strategy feedback');
    feedback = value as unknown as StrategyFeedback;
  }
  const planning = object(diagnostics.planning);
  if (!Number.isSafeInteger(planning.nodesSpent) || (planning.nodesSpent as number) < 0) throw new Error('Invalid city-half-1 search count');
  const base = { gameId: observation.gameId, controlEpoch: observation.controlEpoch,
    basedOnRevision: observation.revision, observedTurn: observation.turn,
    task: { kind, target: tile(task.target) },
    execution: { mode: diagnostics.mode, phase: task.phase, mainTile: tile(task.mainTile), allocatedTiles: task.allocatedTiles.length },
    reason: feedback?.reason ?? `city_half:${diagnostics.mode}`,
    search: { nodes: planning.nodesSpent as number, elapsedMs: reply.computeMs, fallback: diagnostics.mode === 'constraint_fallback' } };
  if (reply.move === null) return { decision: { ...base, kind: 'wait' }, feedback };
  const move = object(reply.move), from = tile(move.from), to = tile(move.to);
  if (from === null || to === null || typeof move.half !== 'boolean'
    || Math.abs(from % observation.width - to % observation.width)
      + Math.abs(Math.floor(from / observation.width) - Math.floor(to / observation.width)) !== 1) throw new Error('Invalid city-half-1 move');
  const source = observation.tiles[from], sentArmies = move.half ? Math.floor(source.armies! / 2) : source.armies! - 1;
  return { decision: { ...base, kind: 'move', move: { from, to, half: move.half },
    prediction: { sentArmies, remainingArmies: source.armies! - sentArmies },
    plan: { routes: [{ path: [from, to], half: move.half }], nextStepOnly: true } }, feedback };
}
