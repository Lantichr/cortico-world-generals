import type { AgentDecision, AgentHistory, AgentObservation, AgentOptions, AgentTile } from '../../src/agent/contracts.ts';
import { GeneralsAgent } from '../../src/agent/agent.ts';

interface Cell { owner: number | null; armies: number; mountain: boolean; city: boolean; general: number | null }
type Move = { from: number; to: number; half: boolean };
export type Baseline = 'stationary' | 'random' | 'expander' | 'pusher' | 'raider';

function random(seed: number): () => number {
  let state = seed | 0;
  return () => { state = Math.imul(state ^ state >>> 16, 0x21f0aaad); state = Math.imul(state ^ state >>> 15, 0x735a2d97); return ((state ^= state >>> 15) >>> 0) / 4294967296; };
}

/** Independent two-player referee: moves are resolved before common 2/50-turn production. */
export class Arena {
  readonly width = 11;
  readonly height = 9;
  readonly cells: Cell[];
  readonly generals: number[];
  readonly history: Array<Array<AgentHistory | null>>;
  turn = 0;
  winner: number | null = null;
  invalidMoves = [0, 0];
  contestedMoves = [0, 0];
  fogProbes = [0, 0];
  readonly rng: () => number;

  constructor(readonly seed: number, mirror = false, cityState = false) {
    this.rng = random(seed);
    this.cells = Array.from({ length: this.width * this.height }, () => ({ owner: null, armies: 0, mountain: false, city: false, general: null }));
    this.generals = mirror ? [this.cells.length - this.width - 2, this.width + 1] : [this.width + 1, this.cells.length - this.width - 2];
    // The central cross and each spawn's two access lanes remain connected.
    for (let y = 1; y < this.height - 1; y++) for (let x = 1; x < this.width - 1; x++) {
      if (x === 1 || x === this.width - 2 || x === 5 || y === 1 || y === 4 || y === this.height - 2) continue;
      if (this.rng() < 0.26) this.cells[y * this.width + x].mountain = true;
    }
    for (const index of [2 * this.width + 3, 2 * this.width + 7, 6 * this.width + 3, 6 * this.width + 7]) {
      Object.assign(this.cells[index], { mountain: false, city: true, armies: 40 + Math.floor(this.rng() * 11) });
    }
    this.generals.forEach((index, owner) => Object.assign(this.cells[index], { owner, armies: 1, mountain: false, city: false, general: owner }));
    if (cityState) for (const index of this.generals) {
      Object.assign(this.cells[index + (index % this.width < this.width / 2 ? 1 : -1)], { city: true, armies: -1, mountain: false });
    }
    this.history = [Array(this.cells.length).fill(null), Array(this.cells.length).fill(null)];
  }

  adjacent(index: number): number[] {
    const result: number[] = [], x = index % this.width, y = Math.floor(index / this.width);
    if (x > 0) result.push(index - 1);
    if (x + 1 < this.width) result.push(index + 1);
    if (y > 0) result.push(index - this.width);
    if (y + 1 < this.height) result.push(index + this.width);
    return result;
  }

  observe(player: number): AgentObservation {
    const visible = new Set<number>();
    for (let index = 0; index < this.cells.length; index++) if (this.cells[index].owner === player) {
      const x = index % this.width, y = Math.floor(index / this.width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(this.height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(this.width - 1, x + 1); xx++) visible.add(yy * this.width + xx);
      }
    }
    const tiles: AgentTile[] = this.cells.map((cell, index) => {
      const seen = visible.has(index);
      const tile = { index, x: index % this.width, y: Math.floor(index / this.width),
        terrain: seen ? cell.mountain ? -2 : cell.owner ?? -1 : cell.mountain || cell.city ? -4 : -3,
        visible: seen, owner: seen && !cell.mountain ? cell.owner : null,
        armies: seen && !cell.mountain ? cell.armies : null,
        general: seen && !cell.mountain ? cell.general !== null : null,
        city: seen && !cell.mountain ? cell.city : null, tunnelLimit: seen && !cell.mountain ? 0 : null };
      if (seen) this.history[player][index] = { ...tile, lastSeenTurn: this.turn };
      return tile;
    });
    return { gameId: `arena:${this.seed}`, revision: this.turn + 1, controlEpoch: 1, playerIndex: player,
      turn: this.turn, width: this.width, height: this.height, tiles, history: structuredClone(this.history[player]),
      generals: this.generals.map((index, owner) => owner === player || visible.has(index) ? index : -1),
      scores: [0, 1].map((i) => ({ i, total: this.cells.filter((cell) => cell.owner === i).reduce((sum, cell) => sum + cell.armies, 0),
        tiles: this.cells.filter((cell) => cell.owner === i).length, dead: this.winner !== null && this.winner !== i })) };
  }

  step(moves: Array<Move | null>): void {
    const validAtObservation = moves.map((move, player) => move === null || !!this.cells[move.from]
      && !!this.cells[move.to] && this.cells[move.from].owner === player && this.cells[move.from].armies >= 2
      && !this.cells[move.to].mountain && this.adjacent(move.from).includes(move.to));
    validAtObservation.forEach((valid, player) => { if (!valid) this.invalidMoves[player]++; });
    // Player order alternates to expose both initiative orders across every game.
    const order = this.turn % 2 ? [1, 0] : [0, 1];
    for (const player of order) {
      const move = moves[player];
      if (!move || this.winner !== null) continue;
      const source = this.cells[move.from], target = this.cells[move.to];
      if (!source || !target || source.owner !== player || source.armies < 2 || target.mountain || !this.adjacent(move.from).includes(move.to)) {
        if (validAtObservation[player]) this.contestedMoves[player]++;
        continue;
      }
      const sent = move.half ? Math.floor(source.armies / 2) : source.armies - 1;
      source.armies -= sent;
      if (target.owner === player) target.armies += sent;
      else if (sent > target.armies) {
        const loser = target.general;
        target.owner = player;
        target.armies = sent - target.armies;
        if (loser !== null) {
          target.general = null;
          target.city = true;
          for (const cell of this.cells) if (cell.owner === loser) { cell.owner = player; cell.armies = Math.round(cell.armies / 2); }
          this.winner = player;
        }
      } else target.armies -= sent;
    }
    this.turn++;
    for (const cell of this.cells) if (cell.owner !== null) {
      if (this.turn % 2 === 0 && (cell.city || cell.general !== null)) cell.armies++;
      if (this.turn % 50 === 0) cell.armies++;
    }
  }

  baseline(kind: Baseline, player: number): Move | null {
    if (kind === 'stationary') return null;
    const observation = this.observe(player);
    const owned = observation.tiles.filter((tile) => tile.owner === player && tile.armies! >= 2);
    const choices: Array<{ move: Move; score: number }> = [];
    const home = this.generals[player], enemyHome = this.generals[1 - player];
    if (kind === 'pusher') {
      const field = [...owned].filter((tile) => tile.index !== home).sort((a, b) => b.armies! - a.armies!)[0];
      const anchor = field && field.armies! >= 6 ? field : observation.tiles[home];
      const distance = (a: number, b: number) => Math.abs(a % this.width - b % this.width)
        + Math.abs(Math.floor(a / this.width) - Math.floor(b / this.width));
      const targets = observation.tiles.filter((tile) => tile.owner !== null && tile.owner !== player)
        .sort((a, b) => Number(b.general) - Number(a.general) || distance(anchor.index, a.index) - distance(anchor.index, b.index));
      const frontier = observation.tiles.filter((tile) => !tile.visible && tile.terrain === -3)
        .sort((a, b) => distance(anchor.index, a.index) - distance(anchor.index, b.index));
      const goal = targets[0]?.index ?? frontier[0]?.index ?? enemyHome;
      for (const source of owned) for (const next of this.adjacent(source.index)) {
        const tile = observation.tiles[next], sent = source.armies! - 1;
        if (tile.terrain === -2 || tile.terrain === -4 || tile.armies !== null && tile.owner !== player && sent <= tile.armies) continue;
        if (source.index === home && source.armies! < 12) continue;
        let score = -1000;
        if (source.index !== anchor.index && tile.owner === player && source.armies! >= 5
          && distance(next, anchor.index) < distance(source.index, anchor.index)) score = 30 + sent / (distance(source.index, anchor.index) + 1);
        if (source.index === anchor.index && source.armies! >= 8) {
          score = 20 + (distance(source.index, goal) - distance(next, goal)) * 10
            + (tile.owner !== player ? 5 : 0) + (tile.city ? 15 : 0) + (tile.general && tile.owner !== player ? 10000 : 0);
        }
        if (score > 0) choices.push({ move: { from: source.index, to: next, half: false }, score: score + this.rng() });
      }
      choices.sort((a, b) => b.score - a.score);
      return choices[0]?.move ?? null;
    }
    for (const source of owned) for (const next of this.adjacent(source.index)) {
      const tile = observation.tiles[next];
      if (tile.terrain === -2 || tile.terrain === -4) continue;
      const sent = source.armies! - 1;
      if (tile.armies !== null && tile.owner !== player && sent <= tile.armies) continue;
      let score = this.rng();
      if (kind === 'expander') score += tile.owner === player ? -10 : 10 + (tile.city ? 20 : 0);
      if (kind === 'raider') {
        const dist = (index: number) => Math.abs(index % this.width - enemyHome % this.width) + Math.abs(Math.floor(index / this.width) - Math.floor(enemyHome / this.width));
        if (source.index === home && source.armies! < 15) continue;
        score += Math.log2(source.armies!) * 5 + (dist(source.index) - dist(next)) * 15 + (tile.general ? 10000 : 0);
      }
      choices.push({ move: { from: source.index, to: next, half: false }, score });
    }
    choices.sort((a, b) => b.score - a.score);
    if (!choices.length) return null;
    return choices[0].move;
  }
}

export interface MatchResult {
  baseline: Baseline;
  seed: number;
  mirror: boolean;
  cityState: boolean;
  winner: number | null;
  turns: number;
  invalidMoves: number;
  contestedMoves: number;
  decisions: number;
  moves: number;
  waits: number;
  unknownProbes: number;
  fallbackDecisions: number;
  longestWait: number;
  maxNodes: number;
  decisionTimes: number[];
  tasks: Record<string, number>;
  endCities: number[];
}

export function playMatch(baseline: Baseline, seed: number, mirror = false, cityState = false, maxTurns = 1200,
  options: AgentOptions = { decisionBudgetMs: 1000, maxSearchNodes: 4000 }): MatchResult {
  const arena = new Arena(seed, mirror, cityState);
  const agent = new GeneralsAgent(options);
  const decisionTimes: number[] = [], tasks: Record<string, number> = {};
  let maxNodes = 0;
  let moves = 0, waits = 0, unknownProbes = 0, fallbackDecisions = 0, waitStreak = 0, longestWait = 0;
  while (arena.winner === null && arena.turn < maxTurns) {
    const observation = arena.observe(0);
    const decision: AgentDecision = agent.decide(observation);
    decisionTimes.push(decision.search.elapsedMs);
    maxNodes = Math.max(maxNodes, decision.search.nodes);
    tasks[decision.task.kind] = (tasks[decision.task.kind] ?? 0) + 1;
    if (decision.kind === 'move') {
      moves++;
      waitStreak = 0;
      if (observation.tiles[decision.move.to].armies === null) unknownProbes++;
    } else {
      waits++;
      longestWait = Math.max(longestWait, ++waitStreak);
    }
    if (decision.search.fallback) fallbackDecisions++;
    arena.step([decision.kind === 'move' ? decision.move : null, arena.baseline(baseline, 1)]);
  }
  return { baseline, seed, mirror, cityState, winner: arena.winner, turns: arena.turn, invalidMoves: arena.invalidMoves[0],
    contestedMoves: arena.contestedMoves[0],
    moves, waits, unknownProbes, fallbackDecisions, longestWait,
    decisions: decisionTimes.length, maxNodes, decisionTimes, tasks,
    endCities: [0, 1].map((player) => arena.cells.filter((cell) => cell.owner === player && (cell.city || cell.general !== null)).length) };
}
