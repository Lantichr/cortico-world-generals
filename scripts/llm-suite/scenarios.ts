import type { AgentObservation } from '../../src/agent/contracts.ts';
import { FfaArena } from '../../tests/agent/ffa-arena.ts';

export interface Scenario {
  id: string;
  description: string;
  create(): { arena: FfaArena; player: number };
  /** Evaluator metadata; it is excluded from model messages. */
  expected?: 'gather' | 'defend' | 'attack_general' | 'clear_intent' | 'reject';
  initialIntent?: (observation: AgentObservation) => Record<string, unknown>;
  beforeReply?: (arena: FfaArena, player: number) => void;
}

function owned(arena: FfaArena, player: number, entries: Array<[number, number]>): void {
  for (const [index, armies] of entries) Object.assign(arena.cells[index], { owner: player, armies });
}

function proposal(observation: AgentObservation, goal: Record<string, unknown>, constraints: Record<string, unknown> = {}): Record<string, unknown> {
  return { gameId: observation.gameId, controlEpoch: observation.controlEpoch, revision: 1,
    basedOnTurn: observation.turn, expiresTurn: observation.turn + 100, goal, constraints };
}

function standardGame(players: number, cityState: boolean): FfaArena {
  const spawns = players === 2 ? [0, 98] : players === 3 ? [0, 10, 98] : [0, 10, 98, 88];
  const arena = new FfaArena(11, 9, spawns, cityState);
  for (const index of [27, 38, 60, 71]) arena.cells[index].mountain = true;
  for (const index of [24, 49, 74]) Object.assign(arena.cells[index], { city: true, armies: index === 49 ? 40 : 25 });
  return arena;
}

/** Each factory owns its board and history; descriptions contain only public situation framing. */
export function snapshotScenarios(): Scenario[] {
  return [
    {
      id: 'dispersed-advantage', description: '公开总兵领先，己方兵力分布在多块相连领地上。', expected: 'gather',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 160;
        owned(arena, 0, [[0, 30], [1, 42], [2, 35], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [12, 30], [13, 1]]);
        arena.cells[10].armies = 80;
        arena.cells[98].armies = 45;
        return { arena, player: 0 };
      },
    },
    {
      id: 'converging-fronts', description: '王城附近出现两种颜色的敌军，附近有己方增援。', expected: 'defend',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 101;
        owned(arena, 0, [[0, 30], [1, 1], [11, 1], [12, 22]]);
        owned(arena, 1, [[2, 24], [10, 20]]);
        owned(arena, 2, [[22, 24], [98, 20]]);
        return { arena, player: 0 };
      },
    },
    {
      id: 'changed-roster', description: '多人对局已发生一次淘汰，仍有其他玩家存活。', expected: 'attack_general',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 280;
        arena.alive[1] = false;
        arena.generals[1] = -1;
        Object.assign(arena.cells[10], { owner: 0, armies: 12, general: null, city: true });
        arena.cells[0].armies = 24;
        owned(arena, 2, [[98, 45], [87, 1], [76, 1], [65, 1], [54, 1], [43, 1], [32, 1], [21, 1],
          [20, 1], [19, 1], [18, 1], [17, 1], [16, 1], [15, 1], [14, 1], [13, 1], [12, 160]]);
        return { arena, player: 2 };
      },
    },
    {
      id: 'held-rally', description: '当前集结目标已有大股兵力，原有意图仍在保留该格驻军。', expected: 'clear_intent',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 200;
        owned(arena, 0, [[0, 50], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 150], [9, 1]]);
        arena.cells[10].armies = 25;
        arena.cells[98].armies = 30;
        return { arena, player: 0 };
      },
      initialIntent: (observation) => proposal(observation, { kind: 'gather', target: { x: 8, y: 0 } },
        { reserves: [{ tile: { x: 8, y: 0 }, armies: 140 }] }),
    },
    {
      id: 'changing-frontier', description: '前线集结格旁有敌军；本轮回复按到达时的当前地图校验。', expected: 'reject',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 120;
        owned(arena, 0, [[0, 30], [1, 12], [11, 15], [12, 24]]);
        owned(arena, 1, [[10, 20], [13, 60]]);
        arena.cells[98].armies = 20;
        return { arena, player: 0 };
      },
      initialIntent: (observation) => proposal(observation, { kind: 'gather', target: { x: 1, y: 1 } }),
      beforeReply: (arena) => arena.step([null, { from: 13, to: 12, half: false }, null], [1, 0, 2]),
    },
    {
      id: 'distant-garrisons', description: '多个已知敌将拥有驻军，己方还有城市和散布的领地。',
      create: () => {
        const arena = new FfaArena(11, 9, [0, 10, 98]);
        arena.turn = 400;
        arena.cells[0].armies = 120;
        arena.cells[10].armies = 120;
        owned(arena, 2, [[98, 180], [97, 1], [86, 40], [85, 30], [75, 1], [64, 1], [53, 1],
          [42, 1], [31, 1], [20, 1], [12, 1]]);
        arena.cells[86].city = true;
        return { arena, player: 2 };
      },
    },
  ];
}

export function gameScenarios(): Scenario[] {
  return [
    { id: 'duel-standard', description: '双人标准规则，从开局运行。', create: () => ({ arena: standardGame(2, false), player: 0 }) },
    { id: 'duel-city-state', description: '双人 City-State 规则，从开局运行。', create: () => ({ arena: standardGame(2, true), player: 1 }) },
    { id: 'ffa-three-standard', description: '三人标准规则，从开局运行。', create: () => ({ arena: standardGame(3, false), player: 2 }) },
    { id: 'ffa-four-city-state', description: '四人 City-State 规则，从开局运行。', create: () => ({ arena: standardGame(4, true), player: 3 }) },
  ];
}
