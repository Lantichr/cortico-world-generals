import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, type PositionAnalysis } from './analysis.ts';
import type { TaskCandidate } from './tasks.ts';

/** The budget fallback inspects one-step moves from the largest eight visible armies. */
export function oneStepFallback(observation: AgentObservation, analysis: PositionAnalysis): TaskCandidate | null {
  let best: TaskCandidate | null = null;
  for (const source of [...analysis.own].sort((a, b) => b.armies! - a.armies!).slice(0, 8)) {
    const reserve = source.index === analysis.home ? analysis.homeReserve : 1;
    const half = reserve > 1;
    const sent = half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    if (sent <= 0 || source.armies! - sent < reserve || source.tunnelLimit !== 0) continue;
    for (const next of neighbors(source.index, observation.width, observation.height)) {
      const tile = observation.tiles[next];
      if (knownWall(observation, next) || tile.tunnelLimit !== 0 || tile.armies === null) continue;
      if (tile.owner === observation.playerIndex && !(next === analysis.home && analysis.threats.length)) continue;
      if (tile.owner !== observation.playerIndex && sent <= tile.armies!) continue;
      const kind = tile.general && tile.owner !== observation.playerIndex ? 'capture_general'
        : next === analysis.home ? 'defend' : tile.city ? 'capture_city' : 'expand';
      const score = kind === 'capture_general' ? 10000 : kind === 'defend' ? 1000
        : kind === 'capture_city' ? 100 : 10 + sent;
      const candidate: TaskCandidate = { kind, score, reason: 'budget_fallback_one_step',
        route: { source: source.index, target: next, path: [source.index, next], half,
          armies: tile.owner === observation.playerIndex ? tile.armies! + sent : sent - tile.armies!, captured: 1, unknown: false } };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}
