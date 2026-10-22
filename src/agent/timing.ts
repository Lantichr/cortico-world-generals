import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import type { DefensePlan } from './defense.ts';
import { findHeldHomeScreen, searchRouteAlternatives, type Route, type SearchBudget } from './search.ts';
import { canPlayerAct, resolvePlayerLifecycles } from './lifecycle.ts';

interface EnemySource { tile: number; owner: number; armies: number; age: number; basis: 'visible' | 'history' }
interface DistanceSearch { distance: number[]; queue: number[]; head: number }

/** Arrival is a lower bound and armies an upper bound: intervening garrisons provide no assumed resistance. */
export interface RouteExposure {
  tile: number;
  enemy: number;
  owner: number;
  arrivalTurns: number;
  armies: number;
  basis: 'visible' | 'history';
}

/** Enemy routes are possibilities through non-wall fog, without extra enemy reinforcements.
 * A null exposure proves only that these sources cannot win the queried collision; undefined means budget exhaustion.
 */
export interface ThreatTiming {
  exposure(index: number, throughTurns: number, friendlyArmies: number, budget: SearchBudget): RouteExposure | null | undefined;
}

/** Distance searches resume only when a force can beat the queried garrison within the queried time. */
export function createThreatTiming(observation: AgentObservation, analysis: PositionAnalysis): ThreatTiming {
  observation = { ...observation, playerLifecycle: resolvePlayerLifecycles(observation) };
  const sources: EnemySource[] = [
    ...analysis.enemies.filter((tile) => tile.armies! > 1 && canPlayerAct(observation, tile.owner!))
      .map((tile) => ({ tile: tile.index, owner: tile.owner!, armies: tile.armies!, age: 0, basis: 'visible' as const })),
    ...analysis.possibleThreats.map((threat) => ({ tile: threat.tile, owner: threat.owner, armies: threat.lastSeenArmies,
      age: observation.turn - threat.lastSeenTurn, basis: 'history' as const })),
  ].sort((a, b) => b.armies - a.armies || a.age - b.age || a.tile - b.tile);
  const searches = new Map<number, DistanceSearch>();
  const distanceTo = (source: number, target: number, budget: SearchBudget): number | undefined => {
    let search = searches.get(source);
    if (!search) {
      search = { distance: Array<number>(observation.tiles.length).fill(Infinity), queue: [source], head: 0 };
      search.distance[source] = 0;
      searches.set(source, search);
    }
    while (search.distance[target] === Infinity && search.head < search.queue.length) {
      if (!budget.take()) return undefined;
      const current = search.queue[search.head++];
      for (const next of neighbors(current, observation.width, observation.height)) {
        const tile = observation.tiles[next];
        if (search.distance[next] !== Infinity || knownWall(observation, next)
          || tile.tunnelLimit !== null && tile.tunnelLimit !== 0) continue;
        search.distance[next] = search.distance[current] + 1;
        search.queue.push(next);
      }
    }
    return search.distance[target];
  };
  return { exposure(index, throughTurns, friendlyArmies, budget) {
    const tile = observation.tiles[index];
    for (const source of sources) {
      // Combat at a force's observed tile is already included in a visible route projection.
      if (source.tile === index && source.basis === 'visible') continue;
      const from = observation.tiles[source.tile];
      const lowerDistance = Math.abs(from.x - tile.x) + Math.abs(from.y - tile.y);
      const lowerArrival = Math.max(source.basis === 'history' ? 1 : 0, lowerDistance - source.age);
      if (lowerArrival > throughTurns || source.armies - Math.max(0, lowerDistance - source.age) < friendlyArmies) continue;
      const distance = distanceTo(source.tile, index, budget);
      if (distance === undefined) return undefined;
      const arrivalTurns = Math.max(source.basis === 'history' ? 1 : 0, distance - source.age);
      const armies = source.armies - Math.max(0, distance - source.age);
      if (arrivalTurns <= throughTurns && armies >= friendlyArmies) return { tile: index, enemy: source.tile, owner: source.owner,
        arrivalTurns, armies, basis: source.basis };
    }
    return null;
  } };
}

export interface MissionTiming {
  status: 'safe' | 'unsafe' | 'unknown';
  deadlineTurn: number | null;
  returnTurns: number | null;
  slackTurns: number | null;
  returnRoute: Route | null;
  reason: string;
}

/** A terminal one-tick capture must survive either attack order, visible reinforcement and a mutual general attack. */
export function assessImmediateGeneralCapture(observation: AgentObservation, analysis: PositionAnalysis, route: Route): MissionTiming | null {
  if (route.path.length !== 2 || observation.generals.length !== 2) return null;
  const source = observation.tiles[route.source], target = observation.tiles[route.target];
  if (!target.visible || !target.general || target.owner === null || target.owner === observation.playerIndex
    || !analysis.enemyGenerals.includes(target.index) || source.owner !== observation.playerIndex || source.armies === null) return null;
  const sent = route.half ? Math.floor(source.armies / 2) : source.armies - 1;
  const home = observation.tiles[analysis.home];
  const homeAfterMove = home.armies! - (source.index === home.index ? sent : 0);
  if (analysis.homeDemands.some((demand) => demand.steps <= 1 && demand.required > homeAfterMove)) return null;
  const score = observation.scores.find((value) => value && typeof value === 'object'
    && !Array.isArray(value) && (value as Record<string, unknown>).i === target.owner) as Record<string, unknown> | undefined;
  const visibleArmies = observation.tiles.filter((tile) => tile.visible && tile.owner === target.owner)
    .reduce((sum, tile) => sum + tile.armies!, 0);
  const noHiddenArmies = Number.isSafeInteger(score?.total) && score!.total === visibleArmies;
  let reinforcement = 0;
  for (const [index, purpose] of [[source.index, 'source'], [target.index, 'target']] as const) {
    for (const neighbor of neighbors(index, observation.width, observation.height)) {
      const tile = observation.tiles[neighbor];
      if (!tile.visible) {
        if (noHiddenArmies) continue;
        return null;
      }
      if (tile.owner === null || tile.owner === observation.playerIndex || !canPlayerAct(observation, tile.owner)) continue;
      if (purpose === 'source') {
        for (const damage of [tile.armies! - 1, Math.floor(tile.armies! / 2)]) {
          const surviving = source.armies - damage;
          const survivingSent = route.half ? Math.floor(surviving / 2) : surviving - 1;
          const defending = target.armies! - (tile.index === target.index ? damage : 0);
          if (survivingSent <= defending) return null;
        }
      } else if (tile.owner === target.owner) reinforcement = Math.max(reinforcement, Math.max(0, tile.armies! - 1));
    }
  }
  if (analysis.possibleThreats.some((threat) => threat.minimumDistance <= 1)) return null;
  if (sent <= target.armies! + reinforcement) return null;
  return { status: 'safe', deadlineTurn: null, returnTurns: null, slackTurns: null, returnRoute: null,
    reason: 'one_tick_general_capture;checked_visible_reinforcement;checked_source_damage;checked_mutual_general_attack;assumption:no_unseen_enemy_reinforcement;attack_before_production' };
}

/** Projects a current-visible route against stationary garrisons and common production. */
export function projectVisibleRoute(observation: AgentObservation, path: number[], half: boolean,
  budget: SearchBudget): { observation: AgentObservation; route: Route } | null {
  const projected = { ...observation, tiles: observation.tiles.map((tile) => ({ ...tile })) };
  let captured = 0;
  for (let step = 1; step < path.length; step++) {
    if (!budget.take()) return null;
    const source = projected.tiles[path[step - 1]], target = projected.tiles[path[step]];
    if (!source || !target || source.owner !== observation.playerIndex || source.armies === null
      || !target.visible || target.armies === null || knownWall(observation, target.index)
      || target.tunnelLimit !== 0 || !neighbors(source.index, observation.width, observation.height).includes(target.index)) return null;
    const sent = step === 1 && half ? Math.floor(source.armies / 2) : source.armies - 1;
    if (sent <= 0) return null;
    source.armies -= sent;
    if (target.owner === observation.playerIndex) target.armies += sent;
    else {
      target.armies = sent - target.armies;
      if (target.armies <= 0) return null;
      target.owner = observation.playerIndex;
      captured++;
    }
    const turn = observation.turn + step;
    for (const tile of projected.tiles) {
      if (tile.owner !== null && tile.armies !== null) tile.armies += production(tile, turn - 1, turn);
    }
  }
  projected.turn += path.length - 1;
  return { observation: projected, route: { source: path[0], target: path.at(-1)!, path,
    armies: projected.tiles[path.at(-1)!].armies!, captured, unknown: false, half } };
}

/** Finds a shortest visible return, including affordable neutral and enemy tiles. Longer alternatives require another search. */
export function findReturnRoute(observation: AgentObservation, source: number, home: number, budget: SearchBudget,
  maxTurns = Infinity): Route | null {
  if (source === home) return { source, target: home, path: [home], armies: observation.tiles[home].armies!,
    captured: 0, unknown: false, half: false };
  const initial = observation.tiles[source];
  if (!initial || initial.owner !== observation.playerIndex || initial.armies === null || initial.armies <= 1) return null;
  const distance = Array<number>(observation.tiles.length).fill(Infinity);
  const best = Array<number>(observation.tiles.length).fill(-Infinity);
  const queue: Route[] = [{ source, target: source, path: [source], armies: initial.armies,
    captured: 0, unknown: false, half: false }];
  distance[source] = 0;
  best[source] = initial.armies;
  let found: Route | null = null;
  for (let head = 0; head < queue.length; head++) {
    const route = queue[head], depth = route.path.length;
    if (depth > maxTurns || found && depth > found.path.length - 1) continue;
    if (!budget.take()) return found;
    for (const next of neighbors(route.target, observation.width, observation.height)) {
      const tile = observation.tiles[next];
      if (depth > distance[next] || route.path.includes(next) || !tile.visible || tile.armies === null
        || tile.tunnelLimit !== 0 || knownWall(observation, next)) continue;
      const sent = route.armies - 1;
      if (sent <= 0) continue;
      const defenders = tile.armies + (tile.owner !== null ? production(tile, observation.turn, observation.turn + depth - 1) : 0);
      let armies = tile.owner === observation.playerIndex ? sent + defenders : sent - defenders;
      if (armies <= 0) continue;
      armies += production(tile, observation.turn + depth - 1, observation.turn + depth);
      if (depth === distance[next] && armies <= best[next]) continue;
      const candidate = { source, target: next, path: [...route.path, next], armies,
        captured: route.captured + Number(tile.owner !== observation.playerIndex), unknown: false, half: false };
      distance[next] = depth;
      best[next] = armies;
      if (next === home) found = candidate;
      else queue.push(candidate);
    }
  }
  return found;
}

/** Mission and return moves consume the same serial clock as defense.
 * All safety results are conditional on stationary visible garrisons, possible enemy paths and no extra enemy reinforcements.
 */
export function assessMissionTiming(observation: AgentObservation, analysis: PositionAnalysis, route: Route,
  budget: SearchBudget, timing = createThreatTiming(observation, analysis), defense: DefensePlan | null = null): MissionTiming {
  return assessMissionPlanTiming(observation, analysis, [route], budget, timing, defense);
}

/** Every leg uses its real source and the same move clock; home coverage is checked at each attack deadline. */
export function assessMissionPlanTiming(observation: AgentObservation, analysis: PositionAnalysis, routes: Route[],
  budget: SearchBudget, timing = createThreatTiming(observation, analysis), defense: DefensePlan | null = null): MissionTiming {
  const result = (status: MissionTiming['status'], deadlineTurn: number | null, returnRoute: Route | null,
    slackTurns: number | null, reason: string): MissionTiming => ({ status, deadlineTurn, returnRoute,
    returnTurns: returnRoute ? returnRoute.path.length - 1 : null, slackTurns,
    reason: `${reason};deadline_turn:${deadlineTurn ?? 'none'};return_moves:${returnRoute ? returnRoute.path.length - 1 : 'unknown'}`
      + `;slack:${slackTurns ?? 'unknown'};assumption:possible_enemy_paths;ignore_enemy_transit_resistance;no_enemy_reinforcement;stationary_visible_garrisons;cumulative_visible_sequences;historical_sources_alternative;selected_enemy_orders;attack_before_production` });
  const originalHome = observation.tiles[analysis.home];
  const demands = analysis.homeDemands;
  const withdrawn = new Set(routes.flatMap((route) => route.path.slice(0, -1)));
  const needsCoverage = withdrawn.has(analysis.home) || demands.some((candidate) => candidate.required > originalHome.armies!
    + production(originalHome, observation.turn, observation.turn + candidate.steps - 1));
  const screen = needsCoverage ? findHeldHomeScreen(observation, analysis, budget,
    { withdrawn, homeArmies: originalHome.armies! }) : null;
  const screenArmies = screen ? observation.tiles[screen.tile].armies! : 0;
  let demand = demands.find((candidate) => candidate.required > originalHome.armies!
    + production(originalHome, observation.turn, observation.turn + candidate.steps - 1)
    && !(screen && originalHome.armies! + screenArmies
      + production(originalHome, observation.turn, observation.turn + candidate.steps - 1) >= screen.enemyArmies));
  let deadlineTurn = demand ? observation.turn + demand.steps : null;
  if (demand) {
    let plannedMoves = 0, firstHomeMove = Infinity;
    for (const route of routes) {
      const arrival = route.path.indexOf(analysis.home, 1);
      if (arrival !== -1) firstHomeMove = Math.min(firstHomeMove, plannedMoves + arrival);
      plannedMoves += route.path.length - 1;
    }
    if (plannedMoves >= demand.steps && firstHomeMove > demand.steps) {
      return result('unsafe', deadlineTurn, null, demand.steps - plannedMoves,
        `mission_outlasts_unmet_home_deadline;first_home_move:${Number.isFinite(firstHomeMove) ? firstHomeMove : 'none'};home_arrival_precheck`);
    }
  }
  let current = observation;
  let moves = 0;
  const available = observation.tiles.map((tile) => tile.armies ?? 0);
  const rememberMove = (position: AgentObservation, from: number, to: number, garrisons: number[]) => {
    for (const index of [from, to]) {
      const tile = position.tiles[index];
      garrisons[index] = tile.armies! - production(tile, position.turn - 1, position.turn);
    }
  };
  const homeTimeline = [originalHome.armies!];
  const screenTimeline = [screenArmies];
  const unmetArrival = (timeline: number[], completionMoves: number, homeArmies: number,
    heldTimeline = screenTimeline, heldArmies = screen ? available[screen.tile] : 0, useScreen = true) => demands.find((candidate) => {
    const armies = (candidate.steps <= completionMoves ? timeline[candidate.steps]
      : homeArmies + production(originalHome, observation.turn + completionMoves, observation.turn + candidate.steps))
      - production(originalHome, observation.turn + candidate.steps - 1, observation.turn + candidate.steps);
    const held = candidate.steps <= completionMoves ? heldTimeline[candidate.steps] : heldArmies;
    return candidate.required > armies && !(useScreen && screen && armies + held >= screen.enemyArmies);
  });
  for (const route of routes) {
    if (route.source !== analysis.home) {
      const waiting = timing.exposure(route.source, moves, available[route.source], budget);
      if (waiting === undefined) return result('unknown', deadlineTurn, null, null, 'mission_waiting_source_budget');
      if (waiting) return result('unsafe', deadlineTurn, null, null, `mission_waiting_source_exposed:${route.source};enemy:${waiting.enemy}`);
    }
    for (let step = 1; step < route.path.length; step++) {
      if (route.path[step - 1] === analysis.home && !screen
        && demands.some((candidate) => candidate.steps <= moves && candidate.required > 1)) {
        return result('unsafe', null, null, null, 'mission_home_outflow_after_possible_attack;damaged_garrison_projection_unavailable');
      }
      const waitingTile = current.tiles[route.path[step]];
      if (waitingTile.owner === observation.playerIndex && waitingTile.index !== analysis.home) {
        const waiting = timing.exposure(waitingTile.index, moves, available[waitingTile.index], budget);
        if (waiting === undefined) return result('unknown', deadlineTurn, null, null, 'mission_waiting_garrison_budget');
        if (waiting) return result('unsafe', deadlineTurn, null, null,
          `mission_waiting_garrison_exposed:${waitingTile.index};enemy:${waiting.enemy}`);
      }
      const projection = projectVisibleRoute(current, [route.path[step - 1], route.path[step]], step === 1 && route.half, budget);
      if (!projection) return result('unknown', deadlineTurn, null, null,
        budget.exhausted ? 'mission_projection_budget' : 'mission_current_visible_projection_unavailable');
      current = projection.observation;
      rememberMove(current, route.path[step - 1], route.path[step], available);
      moves++;
      homeTimeline.push(current.tiles[analysis.home].armies!);
      screenTimeline.push(screen ? available[screen.tile] : 0);
      // The transported force must survive both its arrival turn and the next departure turn.
      if (route.path[step] !== analysis.home && !(screen?.tile === route.path[step]
        && current.tiles[analysis.home].armies! + available[screen.tile] >= screen.enemyArmies)) {
        const exposure = timing.exposure(route.path[step], moves + 1,
          current.tiles[route.path[step]].armies! - production(current.tiles[route.path[step]], current.turn - 1, current.turn), budget);
        if (exposure === undefined) return result('unknown', deadlineTurn, null, null, 'mission_timing_budget');
        if (exposure) return result('unsafe', deadlineTurn, null, null,
          `mission_route_collision:${exposure.tile};enemy:${exposure.enemy};enemy_arrival:${exposure.arrivalTurns}`);
      }
    }
  }
  demand = unmetArrival(homeTimeline, moves, current.tiles[analysis.home].armies!);
  deadlineTurn = demand ? observation.turn + demand.steps : null;
  if (!demand) return result('safe', null, null, null,
    `no_unmet_home_arrival${screen ? `;held_home_screen:${screen.tile};aggregate_enemy:${screen.enemyArmies}` : ''}`);
  if (demand.steps <= moves) return result('unsafe', deadlineTurn, null, demand.steps - moves, 'mission_outlasts_unmet_home_deadline');
  const home = current.tiles[analysis.home];
  const missionTiles = new Set(routes.flatMap((route) => route.path));
  if (defense?.status === 'sufficient' && defense.timingComplete
    && !defense.paths.some((path) => path.some((index) => index !== analysis.home && missionTiles.has(index)))
    && routes.every((route) => route.source !== analysis.home)) {
    const slack = defense.slackTurns - moves;
    if (slack < 0) return result('unsafe', deadlineTurn, null, slack, 'independent_defense_serial_budget');
    let shifted = current;
    const shiftedAvailable = [...available];
    const shiftedHomeTimeline = [...homeTimeline];
    const shiftedScreenTimeline = [...screenTimeline];
    const useScreen = !!screen && !defense.paths.some((path) => path.slice(0, -1).includes(screen.tile));
    for (const path of defense.paths) for (let step = 1; step < path.length; step++) {
      const waitingIndexes = step === 1 ? [path[0], path[step]] : [path[step]];
      for (const index of waitingIndexes) {
        const tile = shifted.tiles[index];
        if (index === analysis.home || tile.owner !== observation.playerIndex) continue;
        const waiting = timing.exposure(index, shifted.turn - observation.turn, shiftedAvailable[index], budget);
        if (waiting === undefined) return result('unknown', deadlineTurn, null, slack, 'shifted_defense_waiting_budget');
        if (waiting) return result('unsafe', deadlineTurn, null, slack, `shifted_defense_waiting_exposed:${index};enemy:${waiting.enemy}`);
      }
      const projection = projectVisibleRoute(shifted, [path[step - 1], path[step]], false, budget);
      if (!projection) return result('unknown', deadlineTurn, null, slack, 'shifted_defense_projection_unavailable');
      shifted = projection.observation;
      rememberMove(shifted, path[step - 1], path[step], shiftedAvailable);
      shiftedHomeTimeline.push(shifted.tiles[analysis.home].armies!);
      shiftedScreenTimeline.push(screen ? shiftedAvailable[screen.tile] : 0);
      if (path[step] === analysis.home) continue;
      const tile = shifted.tiles[path[step]], arrivalArmies = tile.armies! - production(tile, shifted.turn - 1, shifted.turn);
      const exposure = timing.exposure(tile.index, shifted.turn - observation.turn + 1, arrivalArmies, budget);
      if (exposure === undefined) return result('unknown', deadlineTurn, null, slack, 'shifted_defense_timing_budget');
      if (exposure) return result('unsafe', deadlineTurn, null, slack,
        `shifted_defense_collision:${exposure.tile};enemy:${exposure.enemy};enemy_arrival:${exposure.arrivalTurns}`);
    }
    const completionMoves = shifted.turn - observation.turn;
    const uncovered = unmetArrival(shiftedHomeTimeline, completionMoves, shifted.tiles[analysis.home].armies!,
      shiftedScreenTimeline, screen ? shiftedAvailable[screen.tile] : 0, useScreen);
    if (!uncovered) return result('safe', deadlineTurn, null, slack, 'independent_defense_serial_budget');
  }
  const finalTarget = routes.at(-1)?.target ?? analysis.home;
  const returning = findReturnRoute(current, finalTarget, analysis.home, budget, demand.steps - moves);
  const verifyReturn = (candidate: Route | null): MissionTiming => {
    if (!candidate) return result(budget.exhausted ? 'unknown' : 'unsafe', deadlineTurn, null, null, 'no_timely_visible_return');
    const returnMoves = candidate.path.length - 1, slack = demand!.steps - moves - returnMoves;
    const combined = candidate.armies + production(home, current.turn + returnMoves, deadlineTurn! - 1);
    let returningPosition = current;
    const returningAvailable = [...available];
    const returningHomeTimeline = [...homeTimeline];
    const returningScreenTimeline = [...screenTimeline];
    const useScreen = !!screen && !candidate.path.slice(0, -1).includes(screen.tile);
    for (let step = 1; step < candidate.path.length - 1; step++) {
      const waitingTile = returningPosition.tiles[candidate.path[step]];
      if (waitingTile.owner === observation.playerIndex) {
        const waiting = timing.exposure(waitingTile.index, moves + step - 1, returningAvailable[waitingTile.index], budget);
        if (waiting === undefined) return result('unknown', deadlineTurn, candidate, slack, 'return_waiting_garrison_budget');
        if (waiting) return result('unsafe', deadlineTurn, candidate, slack,
          `return_waiting_garrison_exposed:${waitingTile.index};enemy:${waiting.enemy}`);
      }
      const prefix = projectVisibleRoute(returningPosition, [candidate.path[step - 1], candidate.path[step]], false, budget);
      if (!prefix) return result('unknown', deadlineTurn, candidate, slack, 'return_projection_unavailable');
      returningPosition = prefix.observation;
      rememberMove(returningPosition, candidate.path[step - 1], candidate.path[step], returningAvailable);
      returningHomeTimeline.push(returningPosition.tiles[analysis.home].armies!);
      returningScreenTimeline.push(screen ? returningAvailable[screen.tile] : 0);
      const tile = prefix.observation.tiles[candidate.path[step]];
      const exposure = timing.exposure(candidate.path[step], moves + step + 1,
        prefix.route.armies - production(tile, prefix.observation.turn - 1, prefix.observation.turn), budget);
      if (exposure === undefined) return result('unknown', deadlineTurn, candidate, slack, 'return_timing_budget');
      if (exposure) return result('unsafe', deadlineTurn, candidate, slack,
        `return_route_collision:${exposure.tile};enemy:${exposure.enemy};enemy_arrival:${exposure.arrivalTurns}`);
    }
    if (returnMoves > 0) {
      returningHomeTimeline.push(candidate.armies);
      returningScreenTimeline.push(screen ? returningAvailable[screen.tile] : 0);
    }
    const uncovered = unmetArrival(returningHomeTimeline, moves + returnMoves, candidate.armies,
      returningScreenTimeline, screen ? returningAvailable[screen.tile] : 0, useScreen);
    if (uncovered) return result('unsafe', observation.turn + uncovered.steps, candidate, uncovered.steps - moves - returnMoves,
      `return_unmet_home_arrival;required:${uncovered.required}`);
    const covered = combined >= demand!.required
      || useScreen && screen && combined + returningAvailable[screen.tile] >= screen.enemyArmies;
    return result(slack >= 0 && covered ? 'safe' : 'unsafe', deadlineTurn, candidate, slack,
      `mission_and_return;projected_home:${combined};required:${demand!.required}`);
  };
  const primary = verifyReturn(returning);
  if (primary.status === 'safe' || budget.exhausted || !budget.timeAvailable()) return primary;
  const alternatives = searchRouteAlternatives(current, finalTarget, analysis.home, 1, budget,
    { timing, maxTurns: demand.steps - moves, startTurns: moves });
  for (const candidate of alternatives.routes) {
    const alternative = verifyReturn(candidate);
    if (alternative.status === 'safe') return { ...alternative,
      reason: `${alternative.reason};alternative_return;search_complete:${alternatives.complete}` };
  }
  return alternatives.complete ? primary : { ...primary, reason: `${primary.reason};alternative_return_search_incomplete` };
}
