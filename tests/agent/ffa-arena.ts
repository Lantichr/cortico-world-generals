import type { AgentHistory, AgentObservation } from '../../src/agent/contracts.ts';

export interface FfaCell { owner: number | null; armies: number; mountain: boolean; city: boolean; general: number | null }
export interface FfaMove { from: number; to: number; half: boolean }

/** Independent N-player referee; explicit order tests initiative, not the official dependency resolver. */
export class FfaArena {
  readonly cells: FfaCell[];
  readonly generals: number[];
  readonly alive: boolean[];
  readonly invalidMoves: number[];
  readonly contestedMoves: number[];
  readonly history: Array<Array<AgentHistory | null>>;
  turn = 0;
  winner: number | null = null;

  constructor(readonly width: number, readonly height: number, spawns: number[], cityState = false) {
    this.cells = Array.from({ length: width * height }, () => ({ owner: null, armies: 0, mountain: false, city: false, general: null }));
    this.generals = [...spawns];
    this.alive = spawns.map(() => true);
    this.invalidMoves = spawns.map(() => 0);
    this.contestedMoves = spawns.map(() => 0);
    this.history = spawns.map(() => Array(this.cells.length).fill(null));
    spawns.forEach((index, player) => {
      Object.assign(this.cells[index], { owner: player, armies: 1, general: player });
      if (cityState) {
        const neighbor = this.adjacent(index).find((next) => !spawns.includes(next) && !this.cells[next].city)!;
        Object.assign(this.cells[neighbor], { city: true, armies: -1 });
      }
    });
  }

  adjacent(index: number): number[] {
    const x = index % this.width, y = Math.floor(index / this.width), result: number[] = [];
    if (x > 0) result.push(index - 1);
    if (x + 1 < this.width) result.push(index + 1);
    if (y > 0) result.push(index - this.width);
    if (y + 1 < this.height) result.push(index + this.width);
    return result;
  }

  observe(player: number): AgentObservation {
    const visible = new Set<number>();
    this.cells.forEach((cell, index) => {
      if (cell.owner !== player) return;
      const x = index % this.width, y = Math.floor(index / this.width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(this.height - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(this.width - 1, x + 1); xx++) visible.add(yy * this.width + xx);
    });
    const tiles = this.cells.map((cell, index) => {
      const seen = visible.has(index), usable = seen && !cell.mountain;
      const tile = { index, x: index % this.width, y: Math.floor(index / this.width), visible: seen,
        terrain: seen ? cell.mountain ? -2 : cell.owner ?? -1 : cell.mountain || cell.city ? -4 : -3,
        owner: usable ? cell.owner : null, armies: usable ? cell.armies : null,
        general: usable ? cell.general !== null : null, city: usable ? cell.city : null, tunnelLimit: usable ? 0 : null };
      if (seen) this.history[player][index] = { ...tile, lastSeenTurn: this.turn };
      return tile;
    });
    return { gameId: 'ffa-arena', revision: this.turn + 1, controlEpoch: 1, turn: this.turn,
      playerIndex: player, width: this.width, height: this.height, tiles, history: structuredClone(this.history[player]),
      generals: this.generals.map((index, owner) => index >= 0 && (owner === player || visible.has(index)) ? index : -1),
      scores: this.alive.map((alive, i) => ({ i, dead: !alive,
        total: this.cells.filter((cell) => cell.owner === i).reduce((sum, cell) => sum + cell.armies, 0),
        tiles: this.cells.filter((cell) => cell.owner === i).length })) };
  }

  private valid(player: number, move: FfaMove): boolean {
    return this.alive[player] && !!this.cells[move.from] && !!this.cells[move.to]
      && this.cells[move.from].owner === player && this.cells[move.from].armies > 1
      && !this.cells[move.to].mountain && this.adjacent(move.from).includes(move.to);
  }

  step(moves: Array<FfaMove | null>, order = this.alive.map((_, player) => (player + this.turn) % this.alive.length)): void {
    const initialValid = moves.map((move, player) => !move || this.valid(player, move));
    initialValid.forEach((valid, player) => { if (!valid) this.invalidMoves[player]++; });
    const handled = new Set<number>();
    for (const player of order) {
      if (handled.has(player) || this.winner !== null) continue;
      const move = moves[player];
      if (!move || !this.alive[player]) continue;
      if (!this.valid(player, move)) { if (initialValid[player]) this.contestedMoves[player]++; continue; }
      const source = this.cells[move.from], target = this.cells[move.to], opponent = target.general;
      const counter = opponent === null ? null : moves[opponent];
      if (opponent !== null && opponent !== player && counter && !handled.has(opponent) && this.valid(opponent, counter)
        && counter.to === this.generals[player]) {
        const sent = move.half ? Math.floor(source.armies / 2) : source.armies - 1;
        const otherSource = this.cells[counter.from], otherSent = counter.half ? Math.floor(otherSource.armies / 2) : otherSource.armies - 1;
        const selfHome = this.generals[player], enemyHome = this.generals[opponent];
        const selfHeld = this.cells[selfHome].armies - (move.from === selfHome ? sent : 0);
        const enemyHeld = target.armies - (counter.from === enemyHome ? otherSent : 0);
        if (sent > enemyHeld && otherSent > selfHeld) {
          source.armies -= sent;
          otherSource.armies -= otherSent;
          for (let index = 0; index < this.cells.length; index++) {
            if (index === selfHome || index === enemyHome) continue;
            const cell = this.cells[index];
            if (cell.owner === player || cell.owner === opponent) {
              cell.owner = cell.owner === player ? opponent : player;
              cell.armies = Math.round(cell.armies / 2);
            }
          }
          Object.assign(this.cells[selfHome], { owner: opponent, general: opponent, armies: otherSent - selfHeld });
          Object.assign(this.cells[enemyHome], { owner: player, general: player, armies: sent - enemyHeld });
          this.generals[player] = enemyHome;
          this.generals[opponent] = selfHome;
          handled.add(player); handled.add(opponent);
          continue;
        }
      }
      const sent = move.half ? Math.floor(source.armies / 2) : source.armies - 1;
      source.armies -= sent;
      if (target.owner === player) target.armies += sent;
      else if (sent > target.armies) {
        const loser = target.general;
        target.owner = player;
        target.armies = sent - target.armies;
        if (loser !== null) {
          target.general = null; target.city = true;
          this.alive[loser] = false; this.generals[loser] = -1;
          for (const cell of this.cells) if (cell.owner === loser) { cell.owner = player; cell.armies = Math.round(cell.armies / 2); }
          const living = this.alive.flatMap((alive, i) => alive ? [i] : []);
          if (living.length === 1) this.winner = living[0];
        }
      } else target.armies -= sent;
      handled.add(player);
    }
    this.turn++;
    for (const cell of this.cells) if (cell.owner !== null) {
      if (this.turn % 2 === 0 && (cell.general !== null || cell.city)) cell.armies++;
      if (this.turn % 50 === 0) cell.armies++;
    }
  }

  baseline(player: number, kind: 'stationary' | 'expander' | 'pusher'): FfaMove | null {
    if (!this.alive[player] || kind === 'stationary') return null;
    const view = this.observe(player), own = view.tiles.filter((tile) => tile.owner === player && tile.armies! > 1);
    const main = [...own].sort((a, b) => b.armies! - a.armies!)[0];
    const distance = (a: number, b: number) => Math.abs(a % this.width - b % this.width)
      + Math.abs(Math.floor(a / this.width) - Math.floor(b / this.width));
    const targets = view.tiles.filter((tile) => tile.owner !== null && tile.owner !== player)
      .sort((a, b) => Number(b.general) - Number(a.general) || distance(main?.index ?? 0, a.index) - distance(main?.index ?? 0, b.index));
    const frontier = view.tiles.filter((tile) => !tile.visible && tile.terrain === -3)
      .sort((a, b) => distance(main?.index ?? 0, a.index) - distance(main?.index ?? 0, b.index));
    const goal = targets[0]?.index ?? frontier[0]?.index;
    const choices: Array<{ move: FfaMove; score: number }> = [];
    for (const source of own) for (const next of this.adjacent(source.index)) {
      const tile = view.tiles[next], sent = source.armies! - 1;
      if (tile.terrain === -2 || tile.terrain === -4 || tile.armies !== null && tile.owner !== player && sent <= tile.armies) continue;
      if (source.general && source.armies! < 12) continue;
      let score = tile.owner === player ? -10 : 10;
      score += tile.city ? 20 : 0;
      if (tile.general && tile.owner !== player) score += 10000;
      if (kind === 'pusher' && goal !== undefined && main) {
        if (source.index === main.index) score += (distance(source.index, goal) - distance(next, goal)) * 15 + Math.log2(source.armies!);
        else if (tile.owner === player && source.armies! >= 5
          && distance(next, main.index) < distance(source.index, main.index)) score += 30 + sent / (distance(source.index, main.index) + 1);
      }
      choices.push({ move: { from: source.index, to: next, half: false }, score });
    }
    choices.sort((a, b) => b.score - a.score || a.move.from - b.move.from || a.move.to - b.move.to);
    return choices[0]?.move ?? null;
  }
}
