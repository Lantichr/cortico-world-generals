import { parseTiles, type Move } from './moves.ts';
import type { GeneralsState } from './state.ts';
import { applySimulationMove, cloneSimulationBoard, createSimulationBoard, type SimulationBoard } from './simulation.ts';

export const GENERALS_ANALYSIS_LIMITS = { maxMoves: 100 } as const;

export interface GatherOptions {
  target: number;
  maxMoves: number;
  targetArmies?: number;
  sources?: number[];
  reserves: Map<number, number>;
}

export function parseGatherOptions(state: GeneralsState, args: Record<string, unknown>): GatherOptions {
  const point = (value: unknown) => parseTiles([value], state.width, state.height)[0];
  const owned = (index: number, field: string) => {
    const tile = state.tile(index);
    if (!tile.visible || tile.owner !== state.playerIndex) throw new Error(`${field} must be a currently visible self-owned tile`);
  };
  const target = point(args.target);
  owned(target, 'target');
  if (typeof args.maxMoves !== 'number' || !Number.isSafeInteger(args.maxMoves)
    || args.maxMoves < 1 || args.maxMoves > GENERALS_ANALYSIS_LIMITS.maxMoves) {
    throw new Error(`maxMoves must be an integer from 1 to ${GENERALS_ANALYSIS_LIMITS.maxMoves}`);
  }
  if (args.targetArmies !== undefined && (typeof args.targetArmies !== 'number'
    || !Number.isSafeInteger(args.targetArmies) || args.targetArmies < 1)) {
    throw new Error('targetArmies must be a positive integer');
  }
  const sources = args.sources === undefined ? undefined : [...new Set(parseTiles(args.sources, state.width, state.height))];
  sources?.forEach((index) => owned(index, 'sources'));
  const reserves = new Map<number, number>();
  for (let index = 0; index < state.width * state.height; index++) {
    const tile = state.tile(index);
    if (tile.owner === state.playerIndex && tile.general && tile.armies !== null) reserves.set(index, Math.max(1, tile.armies));
  }
  if (args.reserves !== undefined) {
    if (!Array.isArray(args.reserves)) throw new Error('reserves must be an array');
    const explicit = new Set<number>();
    for (const entry of args.reserves) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each reserve must contain tile and armies');
      if (Object.keys(entry).some((key) => key !== 'tile' && key !== 'armies')) throw new Error('Reserve entries accept only tile and armies');
      const { tile, armies } = entry as Record<string, unknown>;
      const index = point(tile);
      owned(index, 'reserves');
      if (typeof armies !== 'number' || !Number.isSafeInteger(armies) || armies < 1) throw new Error('reserve armies must be a positive integer');
      if (explicit.has(index)) throw new Error('Duplicate reserve tile');
      explicit.add(index);
      reserves.set(index, armies);
    }
  }
  return { target, maxMoves: args.maxMoves, targetArmies: args.targetArmies as number | undefined, sources, reserves };
}

function growth(board: SimulationBoard, index: number, endTurn: number): number {
  const tile = board.tiles[index];
  return Math.floor(endTurn / 50) - Math.floor(board.turn / 50)
    + (tile.general || tile.city ? Math.floor(endTurn / 2) - Math.floor(board.turn / 2) : 0);
}

function ownedRoutes(board: SimulationBoard, target: number): Map<number, { next: number; length: number }> {
  const usable = (index: number) => {
    const tile = board.tiles[index];
    return tile.visible && tile.owner === board.playerIndex && tile.tunnelLimit === 0;
  };
  const routes = new Map<number, { next: number; length: number }>();
  if (!usable(target)) return routes;
  routes.set(target, { next: target, length: 0 });
  const queue = [target];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor], x = index % board.width, y = Math.floor(index / board.width);
    const neighbors = [x > 0 ? index - 1 : -1, x + 1 < board.width ? index + 1 : -1,
      y > 0 ? index - board.width : -1, y + 1 < board.height ? index + board.width : -1];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || routes.has(neighbor) || !usable(neighbor)) continue;
      routes.set(neighbor, { next: index, length: routes.get(index)!.length + 1 });
      queue.push(neighbor);
    }
  }
  return routes;
}

type SkipReason = 'no_owned_route' | 'budget_exceeded' | 'reserve_limited' | 'no_movable_armies' | 'no_gain';

/** Greedy shortest owned routes share one serial budget. Each accepted route updates the next candidate's board. */
export function planGather(state: GeneralsState, options: GatherOptions) {
  let board = createSimulationBoard(state);
  const { target, maxMoves, targetArmies, reserves } = options;
  const initialArmies = board.tiles[target].armies!;
  const deadlineTurn = board.turn + maxMoves;
  const routes = ownedRoutes(board, target);
  const sources = (options.sources ?? board.tiles.filter((tile) => tile.owner === board.playerIndex).map((tile) => tile.index))
    .filter((index) => index !== target).sort((a, b) => a - b);
  const point = (index: number) => ({ x: index % board.width, y: Math.floor(index / board.width) });
  const atDeadline = (value: SimulationBoard) => value.tiles[target].armies! + growth(value, target, deadlineTurn);
  const moves: Move[] = [];
  const contributions: Array<{ source: { x: number; y: number }; moves: number; addedArmies: number; arrivalTurn: number }> = [];
  let skipped = new Map<number, SkipReason>();
  while (moves.length < maxMoves && (targetArmies === undefined || atDeadline(board) < targetArmies)) {
    skipped = new Map();
    let best: { source: number; board: SimulationBoard; moves: Move[]; gain: number } | undefined;
    for (const source of sources) {
      const route = routes.get(source);
      if (!route) { skipped.set(source, 'no_owned_route'); continue; }
      if (route.length > maxMoves - moves.length) { skipped.set(source, 'budget_exceeded'); continue; }
      const candidate = cloneSimulationBoard(board), candidateMoves: Move[] = [];
      let from = source, reason: SkipReason | undefined;
      while (from !== target) {
        const to = routes.get(from)!.next;
        const armies = candidate.tiles[from].armies!;
        const reserve = reserves.get(from) ?? 1;
        const half = reserve > 1;
        const sent = half ? Math.floor(armies / 2) : armies - 1;
        if (sent <= 0) { reason = 'no_movable_armies'; break; }
        if (armies - sent < reserve) { reason = 'reserve_limited'; break; }
        const move = { from, to, half };
        const outcome = applySimulationMove(candidate, move, moves.length + candidateMoves.length + 1);
        if (outcome.halt) throw new Error(`Owned route could not be simulated: ${outcome.halt.reason}`);
        candidateMoves.push(move);
        from = to;
      }
      if (reason) { skipped.set(source, reason); continue; }
      const gain = atDeadline(candidate) - atDeadline(board);
      if (gain <= 0) { skipped.set(source, 'no_gain'); continue; }
      if (!best || gain * best.moves.length > best.gain * candidateMoves.length
        || (gain * best.moves.length === best.gain * candidateMoves.length
          && (candidateMoves.length < best.moves.length || (candidateMoves.length === best.moves.length && source < best.source)))) {
        best = { source, board: candidate, moves: candidateMoves, gain };
      }
    }
    if (!best) break;
    moves.push(...best.moves);
    board = best.board;
    contributions.push({ source: point(best.source), moves: best.moves.length, addedArmies: best.gain, arrivalTurn: board.turn });
    skipped.clear();
  }
  const skippedCounts: Partial<Record<SkipReason, number>> = {};
  for (const reason of skipped.values()) skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
  const armyAtDeadline = atDeadline(board);
  return {
    playerIndex: state.playerIndex, observedTurn: state.turn, method: 'greedy_owned_routes',
    assumptions: [
      '假设常规或 City-State 产兵；缺少模式元数据时按常规规则核算。',
      '从 observedTurn 立即开始，每 turn 串行一步；不计旧队列、思考耗时及其他玩家移动。',
      '仅走当前己方可见无隧道的格；sources 指候选起点，沿途己军也参与合兵。',
      '按每步收益贪心选最短路线，受留兵约束时使用半兵；不搜索等待后出发，可能遗漏绕路或更优方案。',
      'armyAtDeadline 包含目标原驻军、合兵及剩余 turn 静置产兵；未达目标不证明无解。',
    ],
    target: point(target), maxMoves, deadlineTurn, initialArmies,
    usedMoves: moves.length, actionEndTurn: board.turn, projectedArmies: board.tiles[target].armies,
    armyAtDeadline, targetArmies: targetArmies ?? null, metTarget: targetArmies === undefined ? null : armyAtDeadline >= targetArmies,
    moves: moves.map((move) => ({ from: point(move.from), to: point(move.to), half: move.half })),
    contributions, reserves: [...reserves].map(([tile, armies]) => ({ tile: point(tile), armies })),
    skipped: { counts: skippedCounts, examples: [...skipped].slice(0, 10).map(([source, reason]) => ({ source: point(source), reason })) },
  };
}
