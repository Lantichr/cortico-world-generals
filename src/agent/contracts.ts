/** Observations, autonomous decisions and strategic preferences have separate authority. */
export interface AgentTile {
  index: number;
  x: number;
  y: number;
  terrain: number;
  visible: boolean;
  owner: number | null;
  armies: number | null;
  general: boolean | null;
  city: boolean | null;
  tunnelLimit: number | null;
}

export interface AgentHistory extends AgentTile { lastSeenTurn: number }

export interface AgentObservation {
  gameId: string;
  revision: number;
  controlEpoch: number;
  playerIndex: number;
  turn: number;
  width: number;
  height: number;
  tiles: AgentTile[];
  history: Array<AgentHistory | null>;
  generals: number[];
  scores: unknown[];
}

export interface AgentOptions {
  decisionBudgetMs: number;
  maxSearchNodes: number;
}

export type AgentTaskKind = 'defend' | 'intercept' | 'capture_general' | 'capture_city' | 'gather' | 'expand' | 'scout' | 'wait';

interface DecisionBase {
  gameId: string;
  controlEpoch: number;
  basedOnRevision: number;
  observedTurn: number;
  task: { kind: AgentTaskKind; target: number | null };
  reason: string;
  search: { nodes: number; elapsedMs: number; fallback: boolean };
  prediction?: { sentArmies: number; remainingArmies: number };
}

export type AgentDecision = DecisionBase & (
  | { kind: 'move'; move: { from: number; to: number; half: boolean };
    /** Selected routes at observedTurn; only move is submitted, and later steps are reconsidered. */
    plan?: { routes: Array<{ path: number[]; half: boolean }>; nextStepOnly: boolean } }
  | { kind: 'wait'; move?: never }
);

export type StrategyGoal =
  | { kind: 'auto' | 'expand' }
  | { kind: 'capture_city' | 'gather' | 'defend' | 'scout'; target: { x: number; y: number } }
  | { kind: 'attack_general'; player: number };

/** Revisions increase within one game and control epoch; expiresTurn is an exclusive upper bound. */
export interface StrategyIntent {
  gameId: string;
  controlEpoch: number;
  revision: number;
  basedOnTurn: number;
  expiresTurn: number;
  goal: StrategyGoal;
  constraints: {
    reserves?: Array<{ tile: { x: number; y: number }; armies: number }>;
    avoidTiles?: Array<{ x: number; y: number }>;
  };
  preferences?: { emphasis: 'balanced' | 'economy' | 'pressure' | 'information'; risk: 'low' | 'normal' | 'high' };
  rationale?: string;
}

export type StrategyIntentStatus = 'autonomous' | 'following' | 'preempted' | 'blocked' | 'completed'
  | 'expired' | 'cancelled' | 'invalidated' | 'stopped';

export interface StrategyIntentState {
  active: StrategyIntent | null;
  status: StrategyIntentStatus;
  reason: string | null;
  lastRevision: number;
  lastRejection: { revision: number | null; reason: string; atTurn: number | null } | null;
}

export interface AgentAction {
  actionId: string;
  gameId: string;
  controlEpoch: number;
  observedTurn: number;
  attackIndex: number;
  from: number;
  to: number;
  half: boolean;
}

export interface AgentFeedback {
  action: AgentAction;
  observedTurn: number;
  outcome: 'server_processed' | 'map_changed' | 'unconfirmed_timeout' | 'cancel_requested';
}

/** A status report separates policy predictions from observed processing and map changes. */
export interface AgentReport {
  gameId: string | null;
  controlEpoch: number;
  control: 'manual' | 'autonomous';
  operatorPaused: boolean;
  phase: string;
  observedTurn: number | null;
  method: 'bounded_rule_search';
  activeIntentRevision: number | null;
  intent: StrategyIntentState;
  supportedRules: 'standard_or_city_state_1v1';
  error: string | null;
  lastDecision: AgentDecision | null;
  pendingAction: AgentAction | null;
  lastFeedback: AgentFeedback | null;
}
