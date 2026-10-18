import type { AgentObservation } from './contracts.ts';
import { knownWall, neighbors, production, type PositionAnalysis } from './analysis.ts';
import { enclosedGatheringSources, type GatheringAnalysis } from './gather.ts';
import type { Route, SearchBudget } from './search.ts';
import { assessMissionTiming, createThreatTiming, type ThreatTiming } from './timing.ts';

export interface TransportEvaluation {
  addedArmies: number;
  moves: number;
  purpose: 'home' | 'army' | 'frontier';
  score: number;
  reason: string;
  canContinue: boolean;
  readyTask?: Route;
}

export interface TransportPlan {
  target: number;
  routes: Route[];
  usedMoves: number;
  projectedArmies: number;
  projectedObservation?: AgentObservation;
}

interface Objective { route: Route; requiredArmies: number }
interface ObjectiveSearch { missions: Objective[]; complete: boolean }
export interface TransportObjectives { [source: number]: ObjectiveSearch }
interface DepartedGarrison { armies: number; turn: number }

/** Chooses one destination for each available purpose rather than treating every owned city as a recipient. */
export function transportTargets(observation: AgentObservation, analysis: PositionAnalysis, gathering: GatheringAnalysis,
  sources: number[], routes: Route[], budget?: SearchBudget,
  timing: ThreatTiming = createThreatTiming(observation, analysis)): number[] {
  const targets = new Set<number>();
  if (sources.some((index) => index !== analysis.home)) targets.add(analysis.home);
  if (gathering.anchor !== null) targets.add(gathering.anchor);
  const frontier = sources.filter((index) => index !== analysis.home && neighbors(index, observation.width, observation.height)
    .some((next) => !knownWall(observation, next) && observation.tiles[next].owner !== observation.playerIndex
      && (observation.tiles[next].visible || observation.tiles[next].terrain !== -4 || observation.history[next]?.city)))
    .map((index) => {
      const adjacent = neighbors(index, observation.width, observation.height).map((next) => observation.tiles[next]);
      const objective = adjacent.find((tile) => tile.owner !== observation.playerIndex && (tile.city || tile.general)
        && tile.armies !== null && tile.armies + 2 > observation.tiles[index].armies!);
      const mission = routes.find((route) => route.source === index && strategicObjective(observation, route));
      return { index, deficit: objective ? objective.armies! + 2 - observation.tiles[index].armies! : Infinity,
        ready: !!mission, unexplored: routes.some((route) => route.source === index && route.unknown),
        armies: observation.tiles[index].armies! };
    }).filter((entry) => !entry.ready && (Number.isFinite(entry.deficit) || entry.unexplored))
    .sort((a, b) => a.deficit - b.deficit || a.armies - b.armies || a.index - b.index)[0];
  if (frontier) targets.add(frontier.index);
  if (budget && gathering.anchor !== null && gathering.anchor !== analysis.home) {
    const fieldSources = new Set(sources.filter((source) => source !== analysis.home));
    const parent = new Map([...fieldSources].map((source) => [source, source]));
    const find = (source: number): number => {
      let root = source;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const candidates: Array<{ route: Route; efficiency: number }> = [];
    for (const route of routes) {
      if (!fieldSources.has(route.source) || !fieldSources.has(route.target) || route.source === route.target
        || route.captured || route.unknown || route.path.includes(analysis.home)
        || observation.tiles[route.source].armies! < 5) continue;
      if (!budget.take()) break;
      parent.set(find(route.source), find(route.target));
      if (route.source === gathering.anchor) continue;
      const moves = route.path.length - 1, target = observation.tiles[route.target];
      const added = route.armies - target.armies! - production(target, observation.turn, observation.turn + moves);
      if (added > 2) candidates.push({ route, efficiency: added / moves });
    }
    if (fieldSources.has(gathering.anchor)) {
      const component = find(gathering.anchor);
      const best = candidates.filter(({ route }) => find(route.target) === component)
        .sort((a, b) => b.efficiency - a.efficiency || a.route.path.length - b.route.path.length
          || a.route.target - b.route.target || a.route.source - b.route.source)
        .find(({ route }) => assessMissionTiming(observation, analysis, route, budget, timing).status === 'safe');
      if (best && best.route.target !== gathering.anchor) targets.add(best.route.target);
    }
  }
  return [...targets];
}

/** Only a proven available objective can interrupt an otherwise valid transport. */
export function evaluateTransport(observation: AgentObservation, analysis: PositionAnalysis, route: Route,
  routes: Route[], budget: SearchBudget, objectives: TransportObjectives = {},
  timing: ThreatTiming = createThreatTiming(observation, analysis)): TransportEvaluation | null {
  return evaluateTransportPlan(observation, analysis, { target: route.target, routes: [route],
    usedMoves: route.path.length - 1, projectedArmies: route.armies }, routes, budget, objectives, timing);
}

/** Multi-leg transports are valued at their final recipient on the same serial movement clock. */
export function evaluateTransportPlan(observation: AgentObservation, analysis: PositionAnalysis, plan: TransportPlan,
  routes: Route[], budget: SearchBudget, objectives: TransportObjectives = {},
  timing: ThreatTiming = createThreatTiming(observation, analysis)): TransportEvaluation | null {
  const moves = plan.usedMoves, target = observation.tiles[plan.target];
  const sources = new Set(plan.routes.map((leg) => leg.source));
  const addedArmies = plan.projectedArmies - target.armies! - production(target, observation.turn, observation.turn + moves);
  if (moves < 1 || addedArmies <= 0) return null;
  const largest = analysis.own.filter((tile) => tile.index !== analysis.home)
    .sort((a, b) => b.armies! - a.armies! || a.index - b.index)[0];
  const purpose = target.index === analysis.home ? 'home' : target.index === largest?.index ? 'army' : 'frontier';
  const recovery = purpose === 'home' && enclosedGatheringSources(observation, analysis, sources,
    budget.fork(Math.floor(budget.remainingNodes / 4))) === true;
  const verified = new Map<string, boolean>();
  const safe = (candidate: Route) => {
    const key = `${candidate.source}:${candidate.half}:${candidate.path.join(',')}`;
    if (!verified.has(key)) verified.set(key, assessMissionTiming(observation, analysis, candidate, budget, timing).status === 'safe');
    return verified.get(key)!;
  };
  const ready = routes.filter((candidate) => strategicObjective(observation, candidate)
    && respectsReserve(observation, analysis, candidate)
    && (candidate.source === plan.target || sources.has(candidate.source) && candidate.path.length - 1 <= moves))
    .sort((a, b) => a.path.length - b.path.length || b.armies - a.armies || a.target - b.target).find(safe);
  if (ready && purpose !== 'home') return { addedArmies, moves, purpose, score: 0, canContinue: false, readyTask: ready,
    reason: 'transport_reconsidered;visible_objective_already_affordable' };
  let useful = addedArmies;
  const missions = (objectives[plan.target] ??= objectiveBudgets(observation, analysis, plan.target, budget)).missions;
  const consumed = plan.projectedObservation || !missions.length ? null : projectedGarrisons(observation, plan.routes, budget);
  const future = missions.map((mission) => {
    if (departureRequirement(mission.requiredArmies, plan.target === analysis.home ? analysis.homeReserve : 1) <= target.armies!
      && !safe(mission.route)) return null;
    return plan.projectedObservation ? objectiveRequirement(plan.projectedObservation, mission.route.path, 0, undefined, budget)
      : consumed ? objectiveRequirement(observation, mission.route.path, moves, consumed, budget) : null;
  });
  const affordable = missions.filter((mission) => departureRequirement(mission.requiredArmies,
    plan.target === analysis.home ? analysis.homeReserve : 1) <= target.armies!)
    .sort((a, b) => a.route.path.length - b.route.path.length).find((mission) => safe(mission.route));
  const recipientTask = affordable?.route ?? (ready?.source === plan.target ? ready : undefined);
  if (recipientTask) {
    let readyTask = recipientTask;
    if (purpose === 'home') {
      const direct = [...sources].flatMap((source) =>
        (objectives[source] ??= objectiveBudgets(observation, analysis, source, budget)).missions);
      readyTask = direct.filter((mission) => mission.requiredArmies <= observation.tiles[mission.route.source].armies!
        && mission.route.target === recipientTask.target && mission.route.path.length <= recipientTask.path.length)
        .sort((a, b) => a.route.path.length - b.route.path.length).find((mission) => safe(mission.route))?.route ?? recipientTask;
    }
    return { addedArmies, moves, purpose, score: 0, canContinue: false, readyTask,
      reason: 'transport_reconsidered;visible_objective_already_affordable' };
  }
  if (purpose !== 'home') {
    const deficits = future.filter((projection) => projection !== null).map((projection) => Math.max(0, projection.requiredArmies - target.armies!
      - production(target, observation.turn, observation.turn + moves)));
    const positive = deficits.filter((deficit) => deficit > 0);
    if (deficits.length === missions.length && deficits.length && !positive.length) useful = 0;
    if (positive.length) useful = Math.min(addedArmies, Math.min(...positive));
    else {
      const before = Math.max(...[...new Set(plan.routes.flatMap((route) => route.path))].map((index) => {
        const tile = observation.tiles[index];
        return tile.armies! + production(tile, observation.turn, observation.turn + moves);
      }));
      useful = Math.min(useful, Math.max(0, plan.projectedArmies - before));
    }
  }
  const reserveGap = Math.max(0, analysis.homeReserve - target.armies!
    - production(target, observation.turn, observation.turn + moves));
  if (purpose === 'home') {
    const offensiveGaps = future.map((projection) => {
      if (!projection) return 0;
      const required = projection.requiredArmies;
      const departure = departureRequirement(required, analysis.homeReserve);
      return departure <= plan.projectedArmies ? Math.max(0, departure - target.armies!
        - production(target, observation.turn, observation.turn + moves)) : 0;
    });
    if (offensiveGaps.some((gap) => gap > 0)) {
      const readyDirect = routes.filter((candidate) => sources.has(candidate.source) && strategicObjective(observation, candidate)
        && missions.some((receiver, index) => offensiveGaps[index] > 0 && receiver.route.target === candidate.target
          && candidate.path.length - 1 <= moves + receiver.route.path.length - 1))
        .sort((a, b) => a.path.length - b.path.length).find(safe);
      if (readyDirect && !reserveGap) return { addedArmies, moves, purpose, score: 0, canContinue: false, readyTask: readyDirect,
        reason: 'transport_reconsidered;direct_objective_completes_before_home_transport' };
      const direct = readyDirect ? [] : [...sources].map((source) =>
        objectives[source] ??= objectiveBudgets(observation, analysis, source, budget));
      const faster = direct.flatMap((search) => search.missions).filter((mission) =>
        mission.requiredArmies <= observation.tiles[mission.route.source].armies!
        && missions.some((receiver, index) => offensiveGaps[index] > 0 && receiver.route.target === mission.route.target
          && mission.route.path.length - 1 <= moves + receiver.route.path.length - 1))
        .sort((a, b) => a.route.path.length - b.route.path.length).find((mission) => safe(mission.route));
      if (faster && !reserveGap) return { addedArmies, moves, purpose, score: 0, canContinue: false, readyTask: faster.route,
        reason: 'transport_reconsidered;direct_objective_completes_before_home_transport' };
      if (readyDirect || faster || direct.some((search) => !search.complete)) offensiveGaps.fill(0);
    }
    useful = recovery ? addedArmies : Math.min(addedArmies, Math.max(reserveGap, ...offensiveGaps));
  }
  const score = purpose === 'home'
    ? useful ? 5 + useful / (moves + 2) * 1.2 + Math.log2(target.armies! + 1) : 0
    : 5 + useful / (moves + 2) * 1.2 + Math.log2(target.armies! + 1);
  return { addedArmies, moves, purpose, score, canContinue: true,
    reason: `owned_transport;purpose:${purpose};added:${addedArmies};moves:${moves};useful:${useful}`
      + (recovery ? ';recovery:all_sources_enclosed_without_home' : '')
      + (plan.routes.length > 1 ? `;legs:${plan.routes.length}` : '') };
}

function projectedGarrisons(observation: AgentObservation, routes: Route[], budget: SearchBudget): Map<number, DepartedGarrison> | null {
  const projected = new Map<number, DepartedGarrison>();
  let elapsed = 0;
  const armiesAt = (index: number, turn: number) => {
    const previous = projected.get(index);
    return previous ? previous.armies + production(observation.tiles[index], previous.turn, turn)
      : observation.tiles[index].armies! + production(observation.tiles[index], observation.turn, turn);
  };
  for (const route of routes) for (let step = 1; step < route.path.length; step++) {
    if (!budget.take()) return null;
    const source = route.path[step - 1], target = route.path[step], turn = observation.turn + elapsed;
    const armies = armiesAt(source, turn), sent = step === 1 && route.half ? Math.floor(armies / 2) : armies - 1;
    projected.set(source, { armies: armies - sent, turn });
    projected.set(target, { armies: armiesAt(target, turn) + sent, turn });
    elapsed++;
  }
  return projected;
}

function strategicObjective(observation: AgentObservation, route: Route): boolean {
  const target = observation.tiles[route.target];
  return !route.unknown && target.visible && target.owner !== observation.playerIndex && !!(target.city || target.general)
    && route.armies > 0 && !route.path.slice(1, -1).includes(observation.generals[observation.playerIndex]);
}

function departureRequirement(required: number, reserve: number): number {
  return reserve > 1 ? Math.max(2 * (required - 1), 2 * reserve - 1) : required;
}

function respectsReserve(observation: AgentObservation, analysis: PositionAnalysis, route: Route): boolean {
  if (route.source !== analysis.home) return true;
  const armies = observation.tiles[route.source].armies!;
  return (route.half ? Math.ceil(armies / 2) : 1) >= analysis.homeReserve;
}

/** Visible shortest paths establish army requirements; incomplete searches establish no interruption. */
function objectiveBudgets(observation: AgentObservation, analysis: PositionAnalysis, source: number,
  budget: SearchBudget): ObjectiveSearch {
  const parent = new Map<number, number>([[source, -1]]), queue = [source], result: Objective[] = [];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === analysis.home && current !== source) continue;
    for (const next of neighbors(current, observation.width, observation.height)) {
      if (!budget.take()) return { missions: result, complete: false };
      const tile = observation.tiles[next];
      if (parent.has(next) || !tile.visible || tile.armies === null || knownWall(observation, next) || tile.tunnelLimit !== 0) continue;
      parent.set(next, current); queue.push(next);
      if (tile.owner === observation.playerIndex || !(tile.city || tile.general)) continue;
      const path = [next];
      while (path.at(-1) !== source) {
        if (!budget.take()) return { missions: result, complete: false };
        path.push(parent.get(path.at(-1)!)!);
      }
      path.reverse();
      const requirement = objectiveRequirement(observation, path, 0, undefined, budget);
      if (!requirement) return { missions: result, complete: false };
      const { offset, requiredArmies, captured } = requirement;
      const half = source === analysis.home && analysis.homeReserve > 1;
      const departure = half ? Math.floor(observation.tiles[source].armies! / 2) + 1 : observation.tiles[source].armies!;
      result.push({ requiredArmies, route: { source, target: next, path, armies: departure + offset,
        captured, unknown: false, half } });
    }
  }
  return { missions: result, complete: true };
}

function objectiveRequirement(observation: AgentObservation, path: number[], delay = 0,
  consumed = new Map<number, DepartedGarrison>(), budget?: SearchBudget): { offset: number; requiredArmies: number; captured: number } | null {
  let offset = 0, requiredArmies = 2, captured = 0;
  for (let step = 1; step < path.length; step++) {
    if (budget && !budget.take()) return null;
    const tile = observation.tiles[path[step]], turn = observation.turn + delay + step;
    requiredArmies = Math.max(requiredArmies, 2 - offset);
    offset--;
    if (tile.owner === observation.playerIndex) {
      const departed = consumed.get(tile.index);
      offset += departed ? departed.armies + production(tile, departed.turn, turn)
        : tile.armies! + production(tile, observation.turn, turn);
    } else {
      captured++;
      offset -= tile.armies! + (tile.owner === null ? 0 : production(tile, observation.turn, turn - 1));
      requiredArmies = Math.max(requiredArmies, 1 - offset);
      offset += production(tile, turn - 1, turn);
    }
  }
  return { offset, requiredArmies, captured };
}
