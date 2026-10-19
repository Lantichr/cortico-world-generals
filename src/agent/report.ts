import type { AgentObservation, AgentReport, AgentTaskKind, AgentTile, StrategyGoal } from './contracts.ts';

export const STRATEGY_BRIEF_LIMITS = { forces: 3, players: 8, reasonCodeLength: 64 } as const;

interface Position { x: number; y: number }
interface ArmyPosition extends Position { armies: number | null }
interface PublicScore {
  player: number;
  total: number;
  tiles: number;
  dead: boolean | null;
  delta: { sinceTurn: number; total: number; tiles: number } | null;
}
interface GeneralFact {
  player: number;
  knownPosition: Position;
  currentArmies: number | null;
  lastSeen: { turn: number; armies: number | null } | null;
}
interface PolicyEstimate {
  basedOnTurn: number;
  reasonCode: string;
  homeDefense: {
    status: 'sufficient' | 'partial' | 'unavailable' | 'recalled' | 'planned';
    requiredArmies: number | null;
    projectedArmies: number | null;
    gapArmies: number | null;
    deadlineTurn: number;
    slackTurns: number | null;
  } | null;
  threat: (Position & { basis: 'visible' | 'history' | 'possible_path'; lastSeenTurn: number | null }) | null;
  assumptions: string[];
}

/** Facts retain their observation turn; policy estimates and processing feedback have independent dates. */
export interface StrategyBrief {
  gameId: string | null;
  controlEpoch: number;
  turn: number | null;
  playerIndex: number | null;
  phase: string;
  control: AgentReport['control'];
  operatorPaused: boolean;
  operatorPauseLinked: boolean;
  intent: {
    status: AgentReport['intent']['status'];
    reasonCode: string | null;
    active: { revision: number; goal: StrategyGoal; expiresTurn: number; reserves: number; avoidTiles: number } | null;
    lastRevision: number;
    lastRejection: { revision: number | null; reasonCode: string; atTurn: number | null } | null;
  };
  currentTask: { kind: AgentTaskKind; target: Position | null; basedOnTurn: number } | null;
  facts: {
    basedOnTurn: number | null;
    home: (ArmyPosition & { owner: number | null }) | null;
    scores: PublicScore[];
    ownCities: number | null;
    ownForces: ArmyPosition[];
    enemyForces: Array<ArmyPosition & { player: number }>;
    enemyGenerals: GeneralFact[];
  };
  estimates: PolicyEstimate | null;
  recentOutcome: {
    actionId: string;
    controlEpoch: number;
    actionTurn: number;
    observedTurn: number;
    outcome: NonNullable<AgentReport['lastFeedback']>['outcome'];
  } | null;
}

const code = (reason: string | null): string | null => reason === null ? null
  : reason.split(/[;:]/, 1)[0].slice(0, STRATEGY_BRIEF_LIMITS.reasonCodeLength);
const position = (observation: AgentObservation | null, index: number | null): Position | null => {
  const tile = index === null ? null : observation?.tiles[index];
  return tile ? { x: tile.x, y: tile.y } : null;
};
const army = (tile: AgentTile): ArmyPosition => ({ x: tile.x, y: tile.y, armies: tile.armies });

function publicScores(observation: AgentObservation, previous?: StrategyBrief): PublicScore[] {
  const sameBaseline = previous?.gameId === observation.gameId && previous.controlEpoch === observation.controlEpoch
    && previous.facts.basedOnTurn !== null && previous.facts.basedOnTurn < observation.turn;
  return observation.scores.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const score = value as Record<string, unknown>;
    if (!Number.isSafeInteger(score.i) || (score.i as number) < 0
      || !Number.isSafeInteger(score.total) || !Number.isSafeInteger(score.tiles)) return [];
    const player = score.i as number, total = score.total as number, tiles = score.tiles as number;
    const before = sameBaseline ? previous.facts.scores.find((entry) => entry.player === player) : null;
    return [{ player, total, tiles, dead: typeof score.dead === 'boolean' ? score.dead : null,
      delta: before ? { sinceTurn: previous!.facts.basedOnTurn!, total: total - before.total, tiles: tiles - before.tiles } : null }];
  }).sort((a, b) => a.player - b.player).slice(0, STRATEGY_BRIEF_LIMITS.players);
}

function enemyGenerals(observation: AgentObservation): GeneralFact[] {
  const known = new Map<number, { index: number; turn: number | null; armies: number | null }>();
  for (const seen of observation.history) {
    if (!seen?.general || seen.owner === null || seen.owner === observation.playerIndex) continue;
    const current = observation.tiles[seen.index];
    if (current.visible && (!current.general || current.owner !== seen.owner)) continue;
    const previous = known.get(seen.owner);
    if (!previous || previous.turn === null || seen.lastSeenTurn > previous.turn) {
      known.set(seen.owner, { index: seen.index, turn: seen.lastSeenTurn, armies: seen.armies });
    }
  }
  for (const [player, index] of observation.generals.entries()) {
    if (player === observation.playerIndex || index < 0) continue;
    const tile = observation.tiles[index];
    if (tile.visible && (!tile.general || tile.owner !== player)) continue;
    const previous = known.get(player);
    if (previous?.index !== index) known.set(player, { index, turn: null, armies: null });
  }
  for (const tile of observation.tiles) {
    if (tile.visible && tile.general && tile.owner !== null && tile.owner !== observation.playerIndex) {
      known.set(tile.owner, { index: tile.index, turn: observation.turn, armies: tile.armies });
    }
  }
  return [...known].sort(([a], [b]) => a - b).slice(0, STRATEGY_BRIEF_LIMITS.players).map(([player, known]) => {
    const tile = observation.tiles[known.index], visible = tile.visible && tile.general && tile.owner === player;
    return { player, knownPosition: { x: tile.x, y: tile.y }, currentArmies: visible ? tile.armies : null,
      lastSeen: !visible && known.turn !== null ? { turn: known.turn, armies: known.armies } : null };
  });
}

const assumptions = ['possible_enemy_paths', 'ignore_enemy_transit_resistance', 'no_enemy_reinforcement',
  'stationary_visible_garrisons', 'ignore_friendly_screen', 'same_turn_home_reinforcement_before_attack',
  'recent_hidden_or_departed_army_may_approach_general'];

function policyEstimate(observation: AgentObservation | null, decision: NonNullable<AgentReport['lastDecision']>): PolicyEstimate {
  const parts = decision.reason.split(';');
  const fields = new Map(parts.filter((part) => part.includes(':')).map((part) => {
    const separator = part.indexOf(':');
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const number = (key: string): number | null => {
    const value = fields.get(key);
    return value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const deadlineTurn = number('deadline_turn');
  const defenseStatus = parts[0].match(/^defense_(sufficient|partial|unavailable)$/)?.[1] as 'sufficient' | 'partial' | 'unavailable' | undefined;
  const requiredArmies = number(defenseStatus ? 'target' : 'required');
  const projectedArmies = number(defenseStatus ? 'projected' : 'projected_home');
  const history = fields.get('history_assumption')?.match(/^(\d+)@(\d+)$/);
  const enemyIndex = history ? Number(history[1]) : number('visible_enemy') ?? number('enemy');
  const threatPosition = position(observation, enemyIndex);
  const declaredAssumptions = new Set(parts.flatMap((part) => part.startsWith('assumption:')
    ? [part.slice('assumption:'.length)] : [part]));
  return { basedOnTurn: decision.observedTurn, reasonCode: code(parts[0] === 'mission_recalled' ? parts[1] : decision.reason)!,
    homeDefense: deadlineTurn === null ? null : {
      status: defenseStatus ?? (parts.includes('mission_recalled') ? 'recalled' : 'planned'), requiredArmies, projectedArmies,
      gapArmies: number('gap') ?? (requiredArmies !== null && projectedArmies !== null ? Math.max(0, requiredArmies - projectedArmies) : null),
      deadlineTurn, slackTurns: number('slack'),
    },
    threat: threatPosition ? { ...threatPosition, basis: history ? 'history' : fields.has('visible_enemy') ? 'visible' : 'possible_path',
      lastSeenTurn: history ? Number(history[2]) : null } : null,
    assumptions: assumptions.filter((assumption) => declaredAssumptions.has(assumption)),
  };
}

/** previous is the last published brief, so score deltas cover the whole reporting interval. */
export function createStrategyBrief(observation: AgentObservation | null, status: AgentReport, previous?: StrategyBrief): StrategyBrief {
  const current = observation?.gameId === status.gameId ? observation : null;
  const decision = status.lastDecision?.gameId === status.gameId && status.lastDecision.controlEpoch === status.controlEpoch
    ? status.lastDecision : null;
  const active = status.intent.active;
  const rejection = status.intent.lastRejection;
  const feedback = status.lastFeedback?.action.gameId === status.gameId ? status.lastFeedback : null;
  const visible = current?.tiles.filter((tile) => tile.visible && tile.armies !== null && tile.owner !== null)
    .sort((a, b) => b.armies! - a.armies! || a.index - b.index) ?? [];
  const home = current?.tiles[current.generals[current.playerIndex]];
  return { gameId: status.gameId, controlEpoch: status.controlEpoch, turn: current?.turn ?? status.observedTurn,
    playerIndex: current?.playerIndex ?? null,
    phase: status.phase, control: status.control, operatorPaused: status.operatorPaused, operatorPauseLinked: status.operatorPauseLinked,
    intent: { status: status.intent.status, reasonCode: code(status.intent.reason),
      active: active ? { revision: active.revision, goal: structuredClone(active.goal), expiresTurn: active.expiresTurn,
        reserves: active.constraints.reserves?.length ?? 0, avoidTiles: active.constraints.avoidTiles?.length ?? 0 } : null,
      lastRevision: status.intent.lastRevision,
      lastRejection: rejection ? { revision: rejection.revision, reasonCode: code(rejection.reason)!, atTurn: rejection.atTurn } : null },
    currentTask: decision ? { kind: decision.task.kind, target: position(current, decision.task.target), basedOnTurn: decision.observedTurn } : null,
    facts: { basedOnTurn: current?.turn ?? null, home: home?.visible ? { ...army(home), owner: home.owner } : null,
      scores: current ? publicScores(current, previous?.controlEpoch === status.controlEpoch ? previous : undefined) : [], ownCities: current
        ? current.tiles.filter((tile) => tile.visible && tile.owner === current.playerIndex && tile.city).length : null,
      ownForces: visible.filter((tile) => tile.owner === current!.playerIndex).slice(0, STRATEGY_BRIEF_LIMITS.forces).map(army),
      enemyForces: visible.filter((tile) => tile.owner !== current!.playerIndex).slice(0, STRATEGY_BRIEF_LIMITS.forces)
        .map((tile) => ({ ...army(tile), player: tile.owner! })),
      enemyGenerals: current ? enemyGenerals(current) : [] },
    estimates: decision ? policyEstimate(current, decision) : null,
    recentOutcome: feedback ? { actionId: feedback.action.actionId, controlEpoch: feedback.action.controlEpoch,
      actionTurn: feedback.action.observedTurn, observedTurn: feedback.observedTurn, outcome: feedback.outcome } : null };
}

/** Ordinary movement, force growth and repeated threats remain on the World's periodic report cadence. */
export function significantStrategyChange(previous: StrategyBrief | null, next: StrategyBrief): string | null {
  if (!previous) return 'initial';
  if (previous.gameId !== next.gameId) return 'game_changed';
  if (previous.controlEpoch !== next.controlEpoch) return 'control_epoch_changed';
  if (previous.phase !== next.phase) return 'phase_changed';
  if (previous.control !== next.control || previous.operatorPaused !== next.operatorPaused
    || previous.operatorPauseLinked !== next.operatorPauseLinked) return 'control_changed';
  if (previous.facts.basedOnTurn === null && next.facts.basedOnTurn !== null) return 'first_observation';
  if (previous.intent.status !== next.intent.status || previous.intent.active?.revision !== next.intent.active?.revision
    || previous.intent.lastRevision !== next.intent.lastRevision) return 'intent_changed';
  if (next.intent.lastRejection && (previous.intent.lastRejection?.revision !== next.intent.lastRejection.revision
    || previous.intent.lastRejection?.reasonCode !== next.intent.lastRejection.reasonCode)) return 'intent_rejected';
  if (next.facts.enemyGenerals.some((general) => !previous.facts.enemyGenerals.some((known) => known.player === general.player))) {
    return 'enemy_general_discovered';
  }
  if (previous.facts.ownCities !== null && next.facts.ownCities !== null && previous.facts.ownCities !== next.facts.ownCities) {
    return 'own_city_count_changed';
  }
  if (!previous.estimates?.homeDefense && next.estimates?.homeDefense) return 'home_defense_needed';
  if ((previous.estimates?.homeDefense?.gapArmies ?? 0) <= 0 && (next.estimates?.homeDefense?.gapArmies ?? 0) > 0) {
    return 'home_defense_shortfall';
  }
  return null;
}
