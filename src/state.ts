function integers(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every(Number.isSafeInteger)) throw new Error('Expected an integer array');
  return value;
}

// Bot Server color indices use the public client's default palette; browser themes may override it.
const colorNames = ['红', '浅蓝', '绿', '青', '橙', '粉', '紫', '栗红', '黄', '棕', '蓝', '蓝紫', '黄绿', '浅红', '浅紫', '浅棕'];

/** Alternating matching and replacement runs; the final matching run may stand alone. */
function patch(previous: number[], value: unknown): number[] {
  const diff = integers(value);
  const result: number[] = [];
  for (let i = 0; i < diff.length;) {
    const matching = diff[i++];
    if (matching < 0 || result.length + matching > previous.length) throw new Error('Invalid matching run');
    const offset = result.length;
    for (let j = offset; j < offset + matching; j++) result.push(previous[j]);
    if (i === diff.length) break;
    const count = diff[i++];
    if (count < 0 || i + count > diff.length) throw new Error('Invalid replacement run');
    for (let end = i + count; i < end; i++) result.push(diff[i]);
    if (result.length > 1_000_000) throw new Error('Map exceeds supported size');
  }
  return result;
}

type SeenTile = ReturnType<GeneralsState['tile']> & { lastSeenTurn: number };

export const GENERALS_ARMY_LIMITS = { default: 10, max: 20 } as const;

interface ArmyTile {
  x: number;
  y: number;
  owner: number;
  armies: number;
  general: boolean;
  city: boolean;
}

/** Stores one game's server view and last-seen facts; fog never refreshes historical armies. */
export class GeneralsState {
  private map: number[] = [];
  private cities: number[] = [];
  private generals: number[] = [];
  private scores: unknown[] = [];
  private history: Array<SeenTile | null> = [];
  private generalHistory: Array<SeenTile | null> = [];
  turn = -1;
  width = 0;
  height = 0;
  serverAttackIndex: number | null = null;
  serverAttackIndexTurn: number | null = null;

  constructor(readonly playerIndex: number, readonly start: Record<string, unknown>) {}

  ownScore(): Record<string, unknown> | null {
    const score = this.scores.find((value) => value !== null && typeof value === 'object'
      && !Array.isArray(value) && (value as Record<string, unknown>).i === this.playerIndex);
    return score ? structuredClone(score as Record<string, unknown>) : null;
  }

  update(data: Record<string, unknown>): void {
    const map = patch(this.map, data.map_diff);
    const cities = patch(this.cities, data.cities_diff);
    const [width, height] = map;
    const size = width * height;
    // Maps contain armies, terrain, and optionally tunnel limits, each with width * height entries.
    if (width <= 0 || height <= 0 || !Number.isSafeInteger(size)
      || (map.length !== 2 + 2 * size && map.length !== 2 + 3 * size)) throw new Error('Invalid map dimensions');
    const generals = integers(data.generals);
    if (!Number.isSafeInteger(data.turn) || (data.turn as number) < 0 || !Array.isArray(data.scores)) throw new Error('Invalid game update');
    if (width !== this.width || height !== this.height) {
      this.history = Array<SeenTile | null>(size).fill(null);
      this.generalHistory = [];
    }
    this.map = map;
    this.cities = cities;
    this.generals = generals;
    this.scores = data.scores;
    this.width = width;
    this.height = height;
    this.turn = data.turn as number;
    if (Number.isSafeInteger(data.attackIndex) && (data.attackIndex as number) >= 0) {
      this.serverAttackIndex = data.attackIndex as number;
      this.serverAttackIndexTurn = this.turn;
    }
    for (let index = 0; index < size; index++) {
      if (map[2 + size + index] >= -2) this.history[index] = { ...this.tile(index), lastSeenTurn: this.turn };
    }
    generals.forEach((index, player) => {
      if (index < 0) return;
      const tile = this.tile(index);
      if (tile.owner === player && tile.general) this.generalHistory[player] = { ...tile, lastSeenTurn: this.turn };
    });
  }

  lastSeen(index: number): SeenTile | null {
    const seen = this.history[index];
    return seen ? { ...seen } : null;
  }

  tile(index: number) {
    const size = this.width * this.height;
    const terrain = this.map[2 + size + index];
    const visible = terrain >= -1;
    return {
      index, x: index % this.width, y: Math.floor(index / this.width), terrain,
      visible: terrain >= -2,
      owner: terrain >= 0 ? terrain : null,
      armies: visible ? this.map[2 + index] : null,
      general: visible ? this.generals.includes(index) : null,
      city: visible ? this.cities.includes(index) : null,
      tunnelLimit: visible ? this.map.length === 2 + 3 * size ? this.map[2 + 2 * size + index] : 0 : null,
    };
  }

  listArmies(side: 'self' | 'enemy' | 'all', limit: number) {
    const groups: Record<'self' | 'enemy' | 'allies' | 'unknown', ArmyTile[]> = { self: [], enemy: [], allies: [], unknown: [] };
    for (let index = 0; index < this.width * this.height; index++) {
      const tile = this.tile(index);
      if (tile.owner === null || tile.armies === null || tile.armies <= 0) continue;
      const relation = this.playerRelation(tile.owner);
      const group = relation === '我' ? 'self' : relation === '敌' ? 'enemy' : relation === '队友' ? 'allies' : 'unknown';
      groups[group].push({ x: tile.x, y: tile.y, owner: tile.owner, armies: tile.armies, general: tile.general === true, city: tile.city === true });
    }
    const selected = side === 'all' ? groups : { [side]: groups[side] };
    return Object.fromEntries(Object.entries(selected).map(([group, tiles]) => [group,
      tiles.sort((a, b) => b.armies - a.armies || a.y - b.y || a.x - b.x).slice(0, limit),
    ]));
  }

  snapshot(): Record<string, unknown> {
    const size = this.width * this.height;
    const selfTiles = Array.from({ length: size }, (_, index) => index)
      .filter((index) => this.map[2 + size + index] === this.playerIndex)
      .map((index) => ({ index, x: index % this.width, y: Math.floor(index / this.width), armies: this.map[2 + index] }));
    const general = this.generals[this.playerIndex];
    const generalEnemyNeighbors = this.generalEnemyNeighbors();
    return {
      playerIndex: this.playerIndex, turn: this.turn, width: this.width, height: this.height,
      selfScore: this.ownScore(), selfTiles, selfGeneral: general >= 0 ? this.tile(general) : null,
      enemyGenerals: this.enemyGenerals(),
      ...(generalEnemyNeighbors ? { generalEnemyNeighbors } : {}),
      armies: this.map.slice(2, 2 + size), terrain: this.map.slice(2 + size, 2 + 2 * size),
      tunnelLimits: this.map.length === 2 + 3 * size ? this.map.slice(2 + 2 * size) : Array(size).fill(0),
      cities: [...this.cities], generals: [...this.generals], scores: structuredClone(this.scores),
      usernames: this.start.usernames, teams: this.start.teams, replayId: this.start.replay_id,
    };
  }

  compactSnapshot(): Record<string, unknown> {
    const { armies, terrain, tunnelLimits, playerIndex, turn, width, height, selfScore, selfGeneral, enemyGenerals, generalEnemyNeighbors, scores } = this.snapshot();
    const size = this.width * this.height;
    const cities = new Set(this.cities), generals = new Set(this.generals.filter((index) => index >= 0));
    const cells = Array.from({ length: size }, (_, index) => {
      const owner = (terrain as number[])[index];
      if (owner === -3 || owner === -4) {
        const fog = owner === -3 ? '?' : 'X';
        const seen = this.history[index];
        if (!seen) return fog;
        const features = seen.terrain === -2 ? '#' : `${seen.general ? 'G' : ''}${seen.city ? 'C' : ''}${seen.tunnelLimit !== null && seen.tunnelLimit !== 0 ? 'T' : ''}` || '.';
        return `${fog}~${features}`;
      }
      if (owner === -2) return '#';
      let cell = `${owner === -1 ? '.' : `p${owner}`}:${(armies as number[])[index]}`;
      if (generals.has(index)) cell += 'G';
      if (cities.has(index)) cell += 'C';
      const tunnel = (tunnelLimits as number[])[index];
      if (tunnel !== 0) cell += `T${tunnel === -1 ? '?' : tunnel}`;
      return cell;
    });
    const header = `y\\x ${Array.from({ length: this.width }, (_, x) => x).join(' ')}`;
    const rows = Array.from({ length: this.height }, (_, y) => `${y} ${cells.slice(y * this.width, (y + 1) * this.width).join(' ')}`);
    return { playerIndex, turn, width, height, selfScore, selfGeneral, enemyGenerals, ...(generalEnemyNeighbors ? { generalEnemyNeighbors } : {}), scores, playerLegend: this.playerLegend(), format: 'compact', grid: [header, ...rows].join('\n') };
  }

  private generalEnemyNeighbors(): string {
    const general = this.generals[this.playerIndex];
    if (!(general >= 0) || this.tile(general).owner !== this.playerIndex) return '';
    const gx = general % this.width, gy = Math.floor(general / this.width);
    const neighbors: string[] = [];
    for (let y = Math.max(0, gy - 1); y <= Math.min(this.height - 1, gy + 1); y++) {
      for (let x = Math.max(0, gx - 1); x <= Math.min(this.width - 1, gx + 1); x++) {
        const tile = this.tile(y * this.width + x);
        if (tile.owner === null) continue;
        const relation = this.playerRelation(tile.owner);
        if (relation === '我' || relation === '队友') continue;
        neighbors.push(`p${tile.owner}${relation === '关系未知' ? '?' : ''}(${x},${y}):${tile.armies}`);
      }
    }
    return neighbors.join('; ');
  }

  private playerCount(): number {
    const colors = Array.isArray(this.start.playerColors) ? this.start.playerColors : [];
    const teams = Array.isArray(this.start.teams) ? this.start.teams : [];
    return Math.max(colors.length, teams.length, this.generals.length, Array.isArray(this.start.usernames) ? this.start.usernames.length : 0, this.playerIndex + 1);
  }

  private playerRelation(player: number): string {
    const teams = Array.isArray(this.start.teams) ? this.start.teams : [];
    return player === this.playerIndex ? '我' : teams[player] !== undefined && teams[player] === teams[this.playerIndex] ? '队友' : teams[player] !== undefined && teams[this.playerIndex] !== undefined ? '敌' : '关系未知';
  }

  private enemyGenerals(): string {
    return Array.from({ length: this.playerCount() }, (_, player) => {
      const relation = this.playerRelation(player);
      if (relation === '我' || relation === '队友') return null;
      const id = `p${player}${relation === '关系未知' ? '?' : ''}`;
      const seen = this.generalHistory[player];
      return seen ? `${id} G(${seen.x},${seen.y}) ${seen.armies}@${seen.lastSeenTurn} ${seen.lastSeenTurn === this.turn ? 'seen' : 'last'}` : `${id} G?`;
    }).filter((line) => line !== null).join('\n');
  }

  private playerLegend(): string {
    const colors = Array.isArray(this.start.playerColors) ? this.start.playerColors : [];
    const teams = Array.isArray(this.start.teams) ? this.start.teams : [];
    return Array.from({ length: this.playerCount() }, (_, i) => {
      const color = colors[i];
      const name = Number.isSafeInteger(color) ? colorNames[color] ?? `色${color}` : '颜色未知';
      const relation = this.playerRelation(i);
      return `p${i} ${name} ${relation}${teams[i] === undefined ? '' : ` 队${teams[i]}`}`;
    }).join('\n');
  }
}
