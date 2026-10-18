import type { AgentObservation, AgentTile } from './contracts.ts';

export interface Threat {
  tile: number;
  armies: number;
  distance: number;
  projectedArrivalArmies: number;
  projectedHomeArmies: number;
}

export interface PositionAnalysis {
  home: number;
  own: AgentTile[];
  enemies: AgentTile[];
  enemyGenerals: number[];
  threats: Threat[];
  possibleThreats: Array<{ tile: number; lastSeenTurn: number; lastSeenArmies: number; minimumDistance: number; reserve: number;
    basis: 'last_seen_fog' | 'departed_visible_tile' }>;
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
  const own = observation.tiles.filter((tile) => tile.owner === observation.playerIndex && tile.armies !== null);
  const home = observation.generals[observation.playerIndex] ?? -1;
  const enemies = observation.tiles.filter((tile) => tile.owner !== null && tile.owner !== observation.playerIndex && tile.armies !== null);
  const enemyGenerals = observation.generals.filter((index, player) => player !== observation.playerIndex && index >= 0);
  for (const seen of observation.history) {
    if (seen?.general && seen.owner !== null && seen.owner !== observation.playerIndex
      && !enemyGenerals.includes(seen.index) && observation.tiles[seen.index].owner !== observation.playerIndex) enemyGenerals.push(seen.index);
  }
  const distance = distances(observation, home, true);
  const losses = approachLosses(observation, home);
  const homeTile = observation.tiles[home];
  const threats = enemies.filter((tile) => tile.armies! > 1 && Number.isFinite(distance[tile.index])).map((tile) => ({
    tile: tile.index, armies: tile.armies!, distance: distance[tile.index],
    projectedArrivalArmies: Math.max(0, tile.armies! - losses[tile.index]),
    projectedHomeArmies: homeTile ? homeTile.armies! + production(homeTile, observation.turn, observation.turn + distance[tile.index]) : 0,
  })).sort((a, b) => a.distance - b.distance || b.armies - a.armies);
  const hidden = observation.history.filter((seen) => seen && !observation.tiles[seen.index].visible
    && seen.owner !== null && seen.owner !== observation.playerIndex && seen.armies !== null && seen.armies >= 5
    && observation.turn - seen.lastSeenTurn <= 12 && Number.isFinite(distance[seen.index]))
    .map((seen) => ({ index: seen!.index, armies: seen!.armies!, lastSeenTurn: seen!.lastSeenTurn, basis: 'last_seen_fog' as const }));
  const possibleThreats = [...hidden, ...departed.map((force) => ({ ...force, basis: 'departed_visible_tile' as const }))]
    .filter((seen) => Number.isFinite(distance[seen.index])).map((seen) => {
    const age = observation.turn - seen.lastSeenTurn;
    const minimumDistance = Math.max(1, distance[seen.index] - age);
    return { tile: seen.index, lastSeenTurn: seen.lastSeenTurn, lastSeenArmies: seen.armies, minimumDistance, basis: seen.basis,
      reserve: Math.max(1, seen.armies - minimumDistance + 1 - production(homeTile, observation.turn, observation.turn + minimumDistance)) };
  });
  const homeReserve = Math.max(1, ...possibleThreats.map((threat) => threat.reserve),
    ...threats.map((threat) => Math.max(1, threat.projectedArrivalArmies + 1
      - production(homeTile, observation.turn, observation.turn + threat.distance))));
  return { home, own, enemies, enemyGenerals, threats, possibleThreats, homeReserve };
}
