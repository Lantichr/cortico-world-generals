import type { Move } from './moves.ts';
import type { GeneralsState } from './state.ts';

export type SimulationTile = ReturnType<GeneralsState['tile']>;

export interface SimulationBoard {
  playerIndex: number;
  width: number;
  height: number;
  observedTurn: number;
  turn: number;
  tiles: SimulationTile[];
  teams: unknown[];
}

export interface SimulationStep {
  step: number;
  turn: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  sourceArmies: number;
  sentArmies: number;
  sourceRemaining: number;
  targetArmies: number;
  targetRemaining: number;
  targetOwner: number | null;
  result: 'merged' | 'captured' | 'held';
}

export interface SimulationHalt {
  step: number;
  reason: 'unknown_current_tile' | 'known_mountain' | 'source_not_owned'
    | 'source_has_no_movable_armies' | 'unsupported_tunnel' | 'unsupported_allied_transfer'
    | 'general_capture_transfer_unmodeled';
}

export const GENERALS_SIMULATION_ASSUMPTIONS = [
  '假设常规规则；每个服务端 turn 串行执行一条有效移动，随后进入下一 turn 并产兵。',
  '房间元数据缺省时按常规规则假设；未声明的特殊机制未核实。',
  '其他玩家不移动；已排入服务端的动作不计入；迷雾不推断兵力或归属。',
  '步骤兵力是战斗后、该次产兵前的值；touchedTiles 是模拟结束时的值。',
  '移动量为零时停止核算；1 兵向己方格的零兵移动未模拟。',
  '攻占敌方将军时停止；其余领地转移和兵力减半未模拟。',
] as const;

/** Each board owns its tile copies; current fog facts never use last-seen armies. */
export function createSimulationBoard(state: GeneralsState): SimulationBoard {
  const options = state.start.options && typeof state.start.options === 'object' && !Array.isArray(state.start.options)
    ? state.start.options as Record<string, unknown> : {};
  const modifiers = options.modifiers;
  if (modifiers !== undefined && (!Array.isArray(modifiers) || modifiers.length > 1 || modifiers.some((value) => value !== 1))) {
    throw new Error('Simulation supports standard rules and City-State only: options.modifiers');
  }
  for (const field of ['map', 'chessClock']) {
    if (options[field] != null) throw new Error(`Simulation does not support options.${field}`);
  }
  if (state.start.chessClock != null) throw new Error('Simulation does not support chessClock');
  if (options.city_regen === true) throw new Error('Simulation does not support options.city_regen');
  for (const field of ['deserts', 'swamps']) {
    if (Array.isArray(state.start[field]) && (state.start[field] as unknown[]).length) {
      throw new Error(`Simulation does not support ${field}`);
    }
  }
  return {
    playerIndex: state.playerIndex, width: state.width, height: state.height,
    observedTurn: state.turn, turn: state.turn,
    tiles: Array.from({ length: state.width * state.height }, (_, index) => state.tile(index)),
    teams: Array.isArray(state.start.teams) ? [...state.start.teams] : [],
  };
}

export function cloneSimulationBoard(board: SimulationBoard): SimulationBoard {
  return { ...board, tiles: board.tiles.map((tile) => ({ ...tile })), teams: [...board.teams] };
}

/** Movement precedes the production of the next server turn, including newly captured cities. */
export function advanceSimulationTurn(board: SimulationBoard): void {
  board.turn++;
  for (const tile of board.tiles) {
    if (tile.owner === null || tile.armies === null) continue;
    if (board.turn % 2 === 0 && (tile.general || tile.city)) tile.armies++;
    if (board.turn % 50 === 0) tile.armies++;
  }
}

/** Accepts parsed adjacent moves. A halted move leaves the board unchanged unless it captured a general. */
export function applySimulationMove(board: SimulationBoard, move: Move, step: number): {
  step: SimulationStep | null;
  halt: SimulationHalt | null;
} {
  const source = board.tiles[move.from], target = board.tiles[move.to];
  const halt = (reason: SimulationHalt['reason']) => ({ step: null, halt: { step, reason } });
  if (source.terrain === -2 || target.terrain === -2) return halt('known_mountain');
  if (source.armies === null || target.armies === null) return halt('unknown_current_tile');
  if (source.tunnelLimit !== 0 || target.tunnelLimit !== 0) return halt('unsupported_tunnel');
  if (source.owner !== board.playerIndex) return halt('source_not_owned');
  const sentArmies = move.half ? Math.floor(source.armies / 2) : source.armies - 1;
  if (sentArmies <= 0) return halt('source_has_no_movable_armies');
  if (target.owner !== null && target.owner !== board.playerIndex
    && board.teams[target.owner] != null && board.teams[target.owner] === board.teams[board.playerIndex]) {
    return halt('unsupported_allied_transfer');
  }
  const sourceArmies = source.armies, targetArmies = target.armies;
  const capturedGeneral = target.owner !== board.playerIndex && target.general === true && sentArmies > targetArmies;
  source.armies -= sentArmies;
  let result: SimulationStep['result'];
  if (target.owner === board.playerIndex) {
    target.armies += sentArmies;
    result = 'merged';
  } else if (sentArmies > targetArmies) {
    target.armies = sentArmies - targetArmies;
    target.owner = board.playerIndex;
    target.terrain = board.playerIndex;
    if (capturedGeneral) { target.general = false; target.city = true; }
    result = 'captured';
  } else {
    target.armies -= sentArmies;
    result = 'held';
  }
  const outcome: SimulationStep = {
    step, turn: board.turn, from: { x: source.x, y: source.y }, to: { x: target.x, y: target.y },
    sourceArmies, sentArmies, sourceRemaining: source.armies,
    targetArmies, targetRemaining: target.armies, targetOwner: target.owner, result,
  };
  advanceSimulationTurn(board);
  return { step: outcome, halt: capturedGeneral ? { step, reason: 'general_capture_transfer_unmodeled' } : null };
}

export function simulateMoves(state: GeneralsState, moves: Move[]) {
  const board = createSimulationBoard(state);
  const steps: SimulationStep[] = [], touched = new Set<number>();
  let halt: SimulationHalt | null = null;
  for (const [i, move] of moves.entries()) {
    const result = applySimulationMove(board, move, i + 1);
    if (result.step) {
      steps.push(result.step);
      touched.add(move.from); touched.add(move.to);
    }
    if (result.halt) { halt = result.halt; break; }
  }
  const touchedTiles = [...touched].sort((a, b) => a - b).map((index) => {
    const { x, y, owner, armies, general, city } = board.tiles[index];
    return { x, y, owner, armies, general, city };
  });
  return {
    playerIndex: state.playerIndex, observedTurn: state.turn, assumptions: GENERALS_SIMULATION_ASSUMPTIONS,
    status: halt ? 'halted' as const : 'complete' as const,
    completedMoves: steps.length, endTurn: board.turn, steps, halt, touchedTiles,
  };
}
