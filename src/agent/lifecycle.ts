import type { AgentHistory, AgentObservation, AgentPlayerLifecycle } from './contracts.ts';

type LifecycleObservation = Pick<AgentObservation, 'turn' | 'tiles' | 'history' | 'generals' | 'scores' | 'playerLifecycle'>;

function generalCandidate(observation: LifecycleObservation, player: number, previous?: AgentPlayerLifecycle): number | null {
  const current = observation.generals[player];
  if (current >= 0) return current;
  if (previous) return previous.generalIndex;
  let latest: AgentHistory | null = null;
  for (const seen of observation.history) {
    if (seen?.general && seen.owner === player && (!latest || seen.lastSeenTurn > latest.lastSeenTurn)) latest = seen;
  }
  return latest?.index ?? null;
}

/** An explicitly active score can invalidate a former general position without eliminating its player. */
export function resolvePlayerLifecycle(observation: LifecycleObservation, player: number,
  previous?: AgentPlayerLifecycle): AgentPlayerLifecycle {
  return resolveLifecycle(observation, player, generalCandidate(observation, player, previous), previous);
}

function resolveLifecycle(observation: LifecycleObservation, player: number, generalIndex: number | null,
  previous?: AgentPlayerLifecycle): AgentPlayerLifecycle {
  const score = observation.scores.find((value) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).i === player) as Record<string, unknown> | undefined;
  const general = generalIndex === null ? null : observation.tiles[generalIndex];
  const replaced = general?.visible && general.terrain >= -1 && general.owner !== player;
  if (score?.dead === false) {
    return { player, status: 'active', basis: 'score', observedTurn: observation.turn,
      generalIndex: replaced || previous?.status === 'eliminated' && !(observation.generals[player] >= 0) ? null : generalIndex };
  }
  if (previous?.status === 'eliminated' && previous.basis !== 'unknown') return { ...previous };
  if (replaced) {
    return { player, status: 'eliminated', basis: general.owner === null ? 'neutralized' : 'captured',
      observedTurn: observation.turn, generalIndex };
  }
  if (previous?.status === 'eliminated') return { ...previous };
  if (score?.dead === true && score.tiles === 0) {
    return { player, status: 'eliminated', basis: 'unknown', observedTurn: observation.turn, generalIndex };
  }
  if (score?.dead === undefined && previous?.status === 'inactive') return { ...previous, generalIndex };
  return { player, status: score?.dead === true ? 'inactive' : 'active',
    basis: typeof score?.dead === 'boolean' ? 'score' : 'unknown', observedTurn: observation.turn, generalIndex };
}

/** Index historical generals once before per-tile threat checks. No cache survives a new observation. */
export function resolvePlayerLifecycles(observation: LifecycleObservation): AgentPlayerLifecycle[] {
  const previous = new Map((observation.playerLifecycle ?? []).map((entry) => [entry.player, entry]));
  const players = new Set([...observation.generals.keys(), ...previous.keys()]);
  const latest = new Map<number, AgentHistory>();
  for (const tile of observation.tiles) if (tile.owner !== null) players.add(tile.owner);
  for (const seen of observation.history) {
    if (!seen || seen.owner === null) continue;
    players.add(seen.owner);
    if (!seen.general) continue;
    if (seen.lastSeenTurn > (latest.get(seen.owner)?.lastSeenTurn ?? -1)) latest.set(seen.owner, seen);
  }
  for (const value of observation.scores) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const player = (value as Record<string, unknown>).i;
    if (Number.isSafeInteger(player) && (player as number) >= 0) players.add(player as number);
  }
  return [...players].sort((a, b) => a - b).map((player) => {
    const current = observation.generals[player], before = previous.get(player);
    const index = current >= 0 ? current : before ? before.generalIndex : latest.get(player)?.index ?? null;
    return resolveLifecycle(observation, player, index, before);
  });
}

export function playerLifecycle(observation: AgentObservation, player: number): AgentPlayerLifecycle {
  const previous = observation.playerLifecycle?.find((entry) => entry.player === player);
  if (!previous) return resolvePlayerLifecycle(observation, player);
  const current = observation.generals[player];
  return resolveLifecycle(observation, player, current >= 0 ? current : previous.generalIndex, previous);
}

export function canPlayerAct(observation: AgentObservation, player: number): boolean {
  return playerLifecycle(observation, player).status === 'active';
}

export function knownGeneralIndex(observation: AgentObservation, player: number): number | null {
  const lifecycle = playerLifecycle(observation, player);
  return lifecycle.status === 'eliminated' ? null : lifecycle.generalIndex;
}

/** Historical ownership remains dated fact, but cannot create a moving army after its owner stops. */
export function historicalArmyMayAct(observation: AgentObservation, seen: AgentHistory): boolean {
  return seen.owner !== null && canPlayerAct(observation, seen.owner);
}
