import type { AgentObservation, AgentTile } from './contracts.ts';
import { canPlayerAct, historicalArmyMayAct, knownGeneralIndex, resolvePlayerLifecycles } from './lifecycle.ts';

export interface Threat {
  tile: number;
  owner: number;
  armies: number;
  distance: number;
  projectedArrivalArmies: number;
  projectedHomeArmies: number;
}

export interface HomeDemand {
  tile: number;
  owner: number;
  steps: number;
  required: number;
  basis: 'visible' | 'history';
  sources: number[];
  scenario: 'single' | 'nearest_first' | 'largest_first';
  lastSeenTurn?: number;
}

export interface PositionAnalysis {
  home: number;
  own: AgentTile[];
  enemies: AgentTile[];
  enemyGenerals: number[];
  threats: Threat[];
  possibleThreats: Array<{ tile: number; owner: number; lastSeenTurn: number; lastSeenArmies: number; minimumDistance: number; reserve: number;
    basis: 'last_seen_fog' | 'departed_visible_tile' }>;
  homeDemands: HomeDemand[];
  homeReserve: number;
}

export interface HiddenArmyEstimate { index: number; owner: number; armies: number; lastSeenTurn: number }

export function neighbors(index: number, width: number, height: number): number[] {
  const result: number[] = [];
  if (index % width > 0) result.push(index - 1);
  if (index % width + 1 < width) result.push(index + 1);
  if (index >= width) result.push(index - width);
  if (index + width < width * height) result.push(index + width);
  return result;
}

export function knownWall(observation: AgentObservation, index: number): boolean {
  return observation.tiles[index].terrain === -2 || observation.history[index]?.terrain === -2;
}

export function production(tile: Pick<AgentTile, 'city' | 'general'>, start: number, end: number): number {
  return Math.floor(end / 50) - Math.floor(start / 50)
    + (tile.city || tile.general ? Math.floor(end / 2) - Math.floor(start / 2) : 0);
}

export function distances(observation: AgentObservation, target: number, allowFog: boolean): number[] {
  const distance = Array<number>(observation.tiles.length).fill(Infinity);
  if (target < 0) return distance;
  const queue = [target];
  distance[target] = 0;
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbors(queue[head], observation.width, observation.height)) {
      const tile = observation.tiles[next];
      if (distance[next] !== Infinity || knownWall(observation, next)
        || (!allowFog && !tile.visible) || (tile.tunnelLimit !== null && tile.tunnelLimit !== 0)) continue;
      distance[next] = distance[queue[head]] + 1;
      queue.push(next);
    }
  }
  return distance;
}

/** Minimum movement and visible friendly-garrison loss; unknown corridors provide no assumed resistance. */
function approachLosses(observation: AgentObservation, home: number): number[] {
  const loss = Array<number>(observation.tiles.length).fill(Infinity);
  if (home < 0) return loss;
  const heap: Array<{ index: number; cost: number }> = [{ index: home, cost: 0 }];
  loss[home] = 0;
  while (heap.length) {
    const current = heap[0], tail = heap.pop()!;
    if (heap.length) {
      heap[0] = tail;
      for (let i = 0;;) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].cost < heap[smallest].cost) smallest = left;
        if (right < heap.length && heap[right].cost < heap[smallest].cost) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    if (current.cost !== loss[current.index]) continue;
    const tile = observation.tiles[current.index];
    const cost = current.cost + 1 + (current.index !== home && tile.owner === observation.playerIndex ? tile.armies! : 0);
    for (const next of neighbors(current.index, observation.width, observation.height)) {
      if (knownWall(observation, next) || cost >= loss[next]) continue;
      loss[next] = cost;
      heap.push({ index: next, cost });
      for (let i = heap.length - 1; i > 0;) {
        const parent = Math.floor((i - 1) / 2);
        if (heap[parent].cost <= heap[i].cost) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    }
  }
  return loss;
}

/** Arrival estimates use visible resistance and assume no unseen enemy reinforcements. */
export function analyzePosition(observation: AgentObservation, departed: HiddenArmyEstimate[] = []): PositionAnalysis {
  observation = { ...observation, playerLifecycle: resolvePlayerLifecycles(observation) };
  const own = observation.tiles.filter((tile) => tile.owner === observation.playerIndex && tile.armies !== null);
  const home = observation.generals[observation.playerIndex] ?? -1;
  const enemies = observation.tiles.filter((tile) => tile.owner !== null && tile.owner !== observation.playerIndex && tile.armies !== null);
  const players = new Set([...observation.generals.keys(), ...(observation.playerLifecycle?.map((entry) => entry.player) ?? []),
    ...observation.history.flatMap((seen) => seen?.general && seen.owner !== null ? [seen.owner] : [])]);
  const enemyGenerals = [...players].filter((player) => player !== observation.playerIndex)
    .flatMap((player) => { const index = knownGeneralIndex(observation, player); return index === null ? [] : [index]; });
  const distance = distances(observation, home, true);
  const losses = approachLosses(observation, home);
  const homeTile = observation.tiles[home];
  const threats = enemies.filter((tile) => canPlayerAct(observation, tile.owner!) && tile.armies! > 1 && Number.isFinite(distance[tile.index])).map((tile) => ({
    tile: tile.index, owner: tile.owner!, armies: tile.armies!, distance: distance[tile.index],
    projectedArrivalArmies: Math.max(0, tile.armies! - losses[tile.index]),
    projectedHomeArmies: homeTile ? homeTile.armies! + production(homeTile, observation.turn, observation.turn + distance[tile.index] - 1) : 0,
  })).sort((a, b) => a.distance - b.distance || b.armies - a.armies);
  const hidden = observation.history.filter((seen) => seen && !observation.tiles[seen.index].visible
    && seen.owner !== null && seen.owner !== observation.playerIndex && historicalArmyMayAct(observation, seen) && seen.armies !== null && seen.armies >= 5
    && observation.turn - seen.lastSeenTurn <= 12 && Number.isFinite(distance[seen.index]))
    .map((seen) => ({ index: seen!.index, owner: seen!.owner!, armies: seen!.armies!, lastSeenTurn: seen!.lastSeenTurn, basis: 'last_seen_fog' as const }));
  const history = new Map<string, typeof hidden[number] | (HiddenArmyEstimate & { basis: 'departed_visible_tile' })>();
  for (const seen of [...hidden, ...departed.filter((force) => canPlayerAct(observation, force.owner))
    .map((force) => ({ ...force, basis: 'departed_visible_tile' as const }))]) {
    const key = `${seen.owner}:${seen.index}`, previous = history.get(key);
    if (!previous || seen.lastSeenTurn > previous.lastSeenTurn || seen.lastSeenTurn === previous.lastSeenTurn && seen.armies > previous.armies) history.set(key, seen);
  }
  const possibleThreats = [...history.values()]
    .filter((seen) => Number.isFinite(distance[seen.index])).map((seen) => {
    const age = observation.turn - seen.lastSeenTurn;
    const minimumDistance = Math.max(1, distance[seen.index] - age);
    return { tile: seen.index, owner: seen.owner, lastSeenTurn: seen.lastSeenTurn, lastSeenArmies: seen.armies, minimumDistance, basis: seen.basis,
      reserve: Math.max(1, seen.armies - minimumDistance + 1 - production(homeTile, observation.turn, observation.turn + minimumDistance - 1)) };
  });
  const homeDemands: HomeDemand[] = [
    ...threats.map((threat) => ({ tile: threat.tile, owner: threat.owner, steps: threat.distance,
      required: Math.max(0, threat.armies - threat.distance) + 1, basis: 'visible' as const,
      sources: [threat.tile], scenario: 'single' as const })),
    ...possibleThreats.map((threat) => ({ tile: threat.tile, owner: threat.owner, steps: threat.minimumDistance,
      required: Math.max(0, threat.lastSeenArmies - threat.minimumDistance) + 1, basis: 'history' as const,
      sources: [threat.tile], scenario: 'single' as const, lastSeenTurn: threat.lastSeenTurn })),
    ...visibleAssaults(observation, home, threats, distance),
  ].sort((a, b) => a.steps - b.steps || b.required - a.required || a.tile - b.tile);
  const homeReserve = homeTile ? Math.max(1, ...possibleThreats.map((threat) => threat.reserve),
    ...threats.map((threat) => Math.max(1, ...homeDemands.filter((demand) => demand.sources.length === 1
      && demand.sources[0] === threat.tile).map((demand) => demand.required - Math.max(0, losses[threat.tile] - threat.distance)
        - production(homeTile, observation.turn, observation.turn + demand.steps - 1)))),
    ...homeDemands.filter((demand) => demand.sources.length > 1).map((demand) => Math.max(1, demand.required
      - production(homeTile, observation.turn, observation.turn + demand.steps - 1)))) : 1;
  return { home, own, enemies, enemyGenerals, threats, possibleThreats, homeDemands, homeReserve };
}

/** Two selected shortest-path assaults share each player's clock and consume merged sources once.
 * Other garrisons provide no resistance; historical locations remain alternative single-force hypotheses.
 */
function visibleAssaults(observation: AgentObservation, home: number, threats: Threat[], distance: number[]): HomeDemand[] {
  const result: HomeDemand[] = [];
  for (const owner of new Set(threats.map((threat) => threat.owner))) {
    const sources = threats.filter((threat) => threat.owner === owner);
    for (const scenario of (sources.length === 1 ? ['nearest_first'] : ['nearest_first', 'largest_first']) as Array<'nearest_first' | 'largest_first'>) {
      const ordered = [...sources].sort((a, b) => scenario === 'nearest_first'
        ? a.distance - b.distance || b.armies - a.armies || a.tile - b.tile
        : b.armies - a.armies || a.distance - b.distance || a.tile - b.tile);
      const armies = observation.tiles.map((tile) => tile.armies ?? 0), owners = observation.tiles.map((tile) => tile.owner);
      const provenance = new Map(sources.map((source) => [source.tile, new Set([source.tile])]));
      const delivered = new Set<number>();
      let steps = 0, damage = 0;
      for (const source of ordered) {
        let from = source.tile;
        if (owners[from] !== owner || armies[from] <= 1) continue;
        while (from !== home && armies[from] > 1) {
          const next = neighbors(from, observation.width, observation.height).filter((index) => distance[index] === distance[from] - 1)
            .sort((a, b) => Number(owners[b] === owner) * armies[b] - Number(owners[a] === owner) * armies[a] || a - b)[0];
          if (next === undefined) break;
          const sent = armies[from] - 1, origins = provenance.get(from) ?? new Set<number>();
          armies[from] = 1;
          provenance.delete(from);
          steps++;
          if (next === home) {
            damage += sent;
            for (const index of origins) delivered.add(index);
            result.push({ tile: source.tile, owner, steps, required: damage + 1, basis: 'visible',
              sources: [...delivered].sort((a, b) => a - b), scenario });
            break;
          }
          const combined = owners[next] === owner ? armies[next] + sent : sent;
          if (owners[next] === owner) for (const index of provenance.get(next) ?? []) origins.add(index);
          armies[next] = combined;
          owners[next] = owner;
          provenance.set(next, origins);
          from = next;
        }
      }
    }
  }
  return result;
}
