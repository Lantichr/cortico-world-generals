import type { AgentDecision, AgentObservation, AgentOptions, StrategyIntent } from './contracts.ts';
import { analyzePosition, neighbors, production, type HiddenArmyEstimate } from './analysis.ts';
import { oneStepFallback } from './fallback.ts';
import { bottleneckScreen, projectOwnedRoute, SearchBudget, searchRoutes, searchRouteAlternatives, type Route } from './search.ts';
import { rankTasks, type TaskCandidate, type TaskCommitment } from './tasks.ts';
import { analyzeGathering, searchGatheringRoutes } from './gather.ts';
import { planDefense } from './defense.ts';
import { assessImmediateGeneralCapture, assessMissionPlanTiming, createThreatTiming, findReturnRoute, projectVisibleRoute, type MissionTiming } from './timing.ts';
import { evaluateTransport, evaluateTransportPlan, transportTargets } from './transport.ts';
import { planGatheringTree, reprojectGatheringTree, type GatheringTreePlan } from './gather-tree.ts';
import { activeStrategyIntent, checkStrategyMove, checkStrategyRoutes, checkStrategyTask, strategyFallback, strategyFeedback,
  strategyGatherTarget, strategyGoalState, strategyReserve, type StrategyFeedback } from './strategy.ts';
import { canPlayerAct, resolvePlayerLifecycles } from './lifecycle.ts';
import { assessFfaRecovery, selectFfaFocus, type FfaFocus } from './ffa.ts';

/** A complete deterministic game policy; it has no Core, Persona or model dependency. */
export class GeneralsAgent {
  private gameId: string | null = null;
  private epoch = -1;
  private revision = -1;
  private turn = -1;
  private commitment: TaskCommitment | null = null;
  private gatheringPlan: { paths: number[][]; deadlineTurn: number } | null = null;
  private readonly retiredGames = new Set<string>();
  private previousForces: HiddenArmyEstimate[] = [];
  private hiddenForces: HiddenArmyEstimate[] = [];
  private strategyRevision: number | null = null;
  private intentFeedback: StrategyFeedback | null = null;
  private completedStrategy: StrategyFeedback | null = null;
  private lifecycleSignature = '';
  private focus: FfaFocus | null = null;

  constructor(private readonly options: AgentOptions) {}

  reset(): void {
    this.gameId = null;
    this.epoch = this.revision = this.turn = -1;
    this.commitment = null;
    this.gatheringPlan = null;
    this.retiredGames.clear();
    this.previousForces = [];
    this.hiddenForces = [];
    this.strategyRevision = null;
    this.intentFeedback = null;
    this.completedStrategy = null;
    this.lifecycleSignature = '';
    this.focus = null;
  }

  getStrategyFeedback(): StrategyFeedback | null { return this.intentFeedback ? { ...this.intentFeedback } : null; }

  /** objectiveCompleted carries completion observed by the caller before this frame. */
  decide(observation: AgentObservation, inputIntent?: StrategyIntent | null, objectiveCompleted = false): AgentDecision {
    const startedAt = performance.now();
    observation = { ...observation, playerLifecycle: resolvePlayerLifecycles(observation) };
    const intent = activeStrategyIntent(observation, inputIntent);
    const finish = (decision: AgentDecision): AgentDecision => {
      if (this.focus) decision.focus = { ...this.focus };
      this.intentFeedback = intent ? this.completedStrategy?.revision === intent.revision ? { ...this.completedStrategy }
        : strategyFeedback(observation, intent, decision) : null;
      if (this.intentFeedback?.status === 'completed') this.completedStrategy = { ...this.intentFeedback };
      return decision;
    };
    const base = { gameId: observation.gameId, controlEpoch: observation.controlEpoch,
      basedOnRevision: observation.revision, observedTurn: observation.turn };
    const wait = (reason: string, updateFeedback = true): AgentDecision => {
      const decision: AgentDecision = { ...base, kind: 'wait', task: { kind: 'wait', target: null }, reason,
        search: { nodes: 0, elapsedMs: performance.now() - startedAt, fallback: false } };
      return updateFeedback ? finish(decision) : decision;
    };
    if (this.retiredGames.has(observation.gameId)
      || this.gameId === observation.gameId && observation.controlEpoch < this.epoch) return wait('older_game_or_control_epoch', false);
    if (this.gameId !== observation.gameId || this.epoch !== observation.controlEpoch) {
      if (this.gameId !== null && this.gameId !== observation.gameId) {
        this.retiredGames.add(this.gameId);
        if (this.retiredGames.size > 32) this.retiredGames.delete(this.retiredGames.values().next().value!);
      }
      this.gameId = observation.gameId;
      this.epoch = observation.controlEpoch;
      this.revision = this.turn = -1;
      this.commitment = null;
      this.gatheringPlan = null;
      this.previousForces = [];
      this.hiddenForces = [];
      this.strategyRevision = null;
      this.intentFeedback = null;
      this.completedStrategy = null;
      this.lifecycleSignature = '';
      this.focus = null;
    }
    if (observation.revision <= this.revision || observation.turn <= this.turn) return wait('duplicate_or_older_observation', false);
    this.revision = observation.revision;
    this.turn = observation.turn;
    const lifecycleSignature = observation.playerLifecycle!.map((entry) => `${entry.player}:${entry.status}:${entry.basis}:${entry.generalIndex}`).join(';');
    if (this.lifecycleSignature !== lifecycleSignature) {
      this.commitment = null;
      this.gatheringPlan = null;
      this.lifecycleSignature = lifecycleSignature;
    }
    if (this.strategyRevision !== (intent?.revision ?? null)) {
      this.commitment = null;
      this.gatheringPlan = null;
      this.strategyRevision = intent?.revision ?? null;
      this.completedStrategy = null;
    }
    if (intent && this.completedStrategy?.revision !== intent.revision) {
      const goal = objectiveCompleted ? { status: 'completed', reason: 'objective_completed_before_current_observation' }
        : strategyGoalState(observation, intent);
      if (goal.status === 'completed') {
        this.completedStrategy = { revision: intent.revision, status: 'completed', reason: goal.reason };
        this.commitment = null;
        this.gatheringPlan = null;
      }
    }
    const completedIntent = intent !== null && this.completedStrategy?.revision === intent.revision;
    const gatherTarget = intent && !completedIntent ? strategyGatherTarget(observation, intent) : null;
    const checkTask = (kind: TaskCandidate['kind'], routes: readonly Pick<Route, 'path'>[]) =>
      intent ? checkStrategyTask(observation, intent, kind, routes, completedIntent) : null;
    const budget = new SearchBudget(this.options.maxSearchNodes, this.options.decisionBudgetMs, startedAt);
    const visibleForces = observation.tiles.filter((tile) => tile.owner !== null && tile.owner !== observation.playerIndex
      && canPlayerAct(observation, tile.owner) && tile.armies! >= 5)
      .map((tile) => ({ index: tile.index, owner: tile.owner!, armies: tile.armies!, lastSeenTurn: observation.turn }));
    const unexplained = (force: HiddenArmyEstimate) => !visibleForces.some((current) => current.owner === force.owner
      && Math.abs(observation.tiles[current.index].x - observation.tiles[force.index].x)
        + Math.abs(observation.tiles[current.index].y - observation.tiles[force.index].y) <= observation.turn - force.lastSeenTurn
      && current.armies >= force.armies * 0.65);
    const hidden = new Map<string, HiddenArmyEstimate>();
    for (const force of [...this.hiddenForces, ...this.previousForces.filter(unexplained)]) {
      const key = `${force.owner}:${force.index}:${force.lastSeenTurn}`;
      if (!hidden.has(key) || hidden.get(key)!.armies < force.armies) hidden.set(key, force);
    }
    this.hiddenForces = [...hidden.values()]
      .filter((force) => canPlayerAct(observation, force.owner) && observation.turn - force.lastSeenTurn <= 12 && unexplained(force))
      .sort((a, b) => b.armies - a.armies || b.lastSeenTurn - a.lastSeenTurn).slice(0, 64);
    this.previousForces = visibleForces;
    const analysis = analyzePosition(observation, this.hiddenForces);
    if (analysis.home < 0 || !observation.tiles[analysis.home]
      || observation.tiles[analysis.home].owner !== observation.playerIndex) return wait('own_general_unavailable');
    const focus = selectFfaFocus(observation, analysis, this.focus?.player ?? null, completedIntent ? null : intent);
    if (this.focus?.player !== focus?.player && this.commitment
      && !['defend', 'intercept', 'gather'].includes(this.commitment.kind)) this.commitment = null;
    this.focus = focus;
    const timing = createThreatTiming(observation, analysis);
    let tree: GatheringTreePlan | null = null;
    let transport: TaskCandidate | null = null;
    let continuation: TaskCandidate | null = null;
    if (this.gatheringPlan) {
      tree = reprojectGatheringTree(observation, analysis, this.gatheringPlan.paths,
        budget.fork(Math.floor(budget.remainingNodes / 8)), timing, this.gatheringPlan.deadlineTurn);
      if (tree) transport = { route: tree.route, kind: 'gather', score: 80,
        reason: `committed_gather_tree;${tree.reason};reobserve_after_step` };
      else { this.gatheringPlan = null; this.commitment = null; }
    } else if (this.commitment?.path) {
      const path = this.commitment.path;
      const route = path.length > 1 && path[0] === this.commitment.army && path.at(-1) === this.commitment.target
        ? this.commitment.kind === 'gather'
          ? projectOwnedRoute(observation, path, Math.max(path[0] === analysis.home ? analysis.homeReserve : 1,
            strategyReserve(observation, intent, path[0])))
          : observation.tiles[this.commitment.target].owner !== observation.playerIndex
            ? projectVisibleRoute(observation, path, false, budget)?.route : null
        : null;
      if (!route) this.commitment = null;
      else if (this.commitment.kind === 'gather') transport = { route, kind: 'gather', score: 80,
        reason: 'committed_gather;current_owned_route;reobserve_after_step' };
      else continuation = { route, kind: this.commitment.kind, score: 80,
        reason: 'committed_mission_prefix;current_visible_route;reobserve_after_step' };
    }
    const defense = planDefense(observation, analysis, budget.fork(Math.floor(budget.remainingNodes / 2)),
      this.commitment?.kind === 'defend' ? this.commitment.army : null, timing);
    const defenseRoutes = defense?.route ? defense.paths.map((path, index) => ({ ...defense.route!, path,
      source: path[0], target: path.at(-1)!, half: index === 0 && defense.route!.half })) : [];
    const assessMission = (missionRoutes: Route[]): MissionTiming => {
      const compatibleDefense = intent && defense && checkStrategyRoutes(observation, intent, [...missionRoutes, ...defenseRoutes])
        ? null : defense;
      let assessment = missionRoutes.length === 1 && assessImmediateGeneralCapture(observation, analysis, missionRoutes[0])
        || assessMissionPlanTiming(observation, analysis, missionRoutes, budget, timing, compatibleDefense);
      if (observation.generals.length > 2 && assessment.status === 'unsafe'
        && defense && defense.status !== 'sufficient' && !defense.actionRequired && missionRoutes.length === 1) {
        assessment = assessFfaRecovery(observation, analysis, missionRoutes[0], budget, timing) ?? assessment;
      }
      if (intent && assessment.status !== 'unsafe' && assessment.returnRoute) {
        const rejected = checkStrategyRoutes(observation, intent, [...missionRoutes, assessment.returnRoute]);
        if (rejected) return { ...assessment, status: 'unsafe', reason: `${assessment.reason};strategy_return_rejected:${rejected}` };
      }
      return assessment;
    };
    const constrainedFallback = (): TaskCandidate | null => {
      const fallback = intent ? strategyFallback(observation, analysis, intent, completedIntent, defense !== null) : oneStepFallback(observation, analysis);
      if (fallback?.kind === 'capture_general' && assessMission([fallback.route]).status !== 'safe') return null;
      return intent && fallback && fallback.kind !== 'defend' && fallback.kind !== 'intercept'
        && assessMission([fallback.route]).status === 'unsafe' ? null : fallback;
    };
    let recovery: TaskCandidate | null = null;
    if (observation.generals.length > 2 && defense && defense.status !== 'sufficient' && !defense.actionRequired) {
      const recoveryBudget = budget.fork(Math.floor(budget.remainingNodes / 5));
      const own = [...analysis.own].filter((tile) => tile.index !== analysis.home && tile.armies! > 2)
        .sort((a, b) => b.armies! - a.armies! || a.index - b.index);
      for (const source of own) {
        for (const target of neighbors(source.index, observation.width, observation.height)) {
          const projected = projectVisibleRoute(observation, [source.index, target], false, recoveryBudget);
          if (!projected || checkTask(observation.tiles[target].owner === observation.playerIndex ? 'gather' : 'capture_city', [projected.route])) continue;
          if (intent && (checkStrategyRoutes(observation, intent, [projected.route])
            || checkStrategyMove(observation, intent, { from: source.index, to: target, half: false }))) continue;
          const assessment = assessFfaRecovery(observation, analysis, projected.route, recoveryBudget, timing);
          if (!assessment) continue;
          recovery = { route: projected.route, kind: observation.tiles[target].owner === observation.playerIndex ? 'gather' : 'capture_city',
            score: 20, reason: assessment.reason };
          break;
        }
        if (recovery || recoveryBudget.exhausted) break;
      }
    }
    const gathering = defense?.actionRequired || transport || continuation ? { anchor: null, recover: null }
      : analyzeGathering(observation, analysis, budget.fork(Math.floor(budget.remainingNodes / 8)));
    const sources = [...analysis.own].filter((tile) => tile.armies! > 1)
      .sort((a, b) => Number(b.index === this.commitment?.army) - Number(a.index === this.commitment?.army)
        || b.armies! - a.armies! || a.index - b.index).slice(0, 12);
    const routes: Route[] = [];
    const routeBudget = budget.fork(Math.floor(budget.remainingNodes * 0.6));
    for (const [index, source] of sources.entries()) {
      // Save an initial marching force instead of repeatedly deploying newly produced single soldiers.
      if (source.index === analysis.home && source.armies! < 7 && !analysis.threats.length) continue;
      const remainingWeight = sources.slice(index).reduce((sum, tile) => sum + Math.sqrt(tile.armies!), 0);
      // Larger armies need longer attack routes while other sources retain a share of the search.
      const allowance = Math.max(1, Math.floor(routeBudget.remainingNodes * Math.sqrt(source.armies!) / remainingWeight));
      routes.push(...searchRoutes(observation, source.index, Math.max(source.index === analysis.home ? analysis.homeReserve : 1,
        strategyReserve(observation, intent, source.index)), routeBudget, false, allowance));
      if (routeBudget.exhausted) break;
    }
    let gatheringTargets: number[] | undefined;
    if (!defense?.actionRequired && !transport && !continuation) {
      const targets = gatheringTargets = transportTargets(observation, analysis, gathering,
        sources.map((source) => source.index), routes, budget.fork(Math.floor(budget.remainingNodes / 5)), timing);
      const gatheringBudget = budget.fork(Math.floor(budget.remainingNodes / 2));
      for (const target of targets) {
        routes.push(...searchGatheringRoutes(observation, analysis, target, sources.map((source) => source.index), gatheringBudget));
        if (gatheringBudget.exhausted) break;
      }
    }
    if (transport) {
      const purposeBudget = budget.fork(Math.floor(budget.remainingNodes / 4));
      const purpose = tree ? evaluateTransportPlan(observation, analysis, tree, routes, purposeBudget, {}, timing)
        : evaluateTransport(observation, analysis, transport.route, routes, purposeBudget, {}, timing);
      if (!purpose || !purpose.canContinue) {
        if (purpose?.readyTask) routes.push(purpose.readyTask);
        transport = null;
        this.commitment = null;
        this.gatheringPlan = null;
        tree = null;
      }
    }
    const candidates = rankTasks(observation, analysis, routes, this.commitment,
      budget.fork(Math.floor(budget.remainingNodes / 2)), gathering, defense?.actionRequired ?? false, timing, gatheringTargets, intent,
      completedIntent, this.focus);
    let candidate: TaskCandidate | null = candidates[0]
      ?? (budget.exhausted || budget.remainingNodes === 0 || !budget.timeAvailable()
        ? constrainedFallback() : null);
    if (defense?.actionRequired) {
      const reinforcement: TaskCandidate | null = defense.route ? { route: defense.route, kind: 'defend',
        score: defense.status === 'sufficient' ? 1100 : 1000, reason: defense.reason } : null;
      if (reinforcement && (!candidate || candidate.score < reinforcement.score)) candidate = reinforcement;
      if (!reinforcement && candidate?.kind !== 'intercept' && candidate?.kind !== 'capture_general') candidate = null;
    } else if ((transport || continuation) && candidate?.kind !== 'defend' && candidate?.kind !== 'intercept'
      && !(candidate?.kind === 'capture_general' && candidate.route.path.length === 2)) candidate = transport ?? continuation;
    if (candidate?.kind === 'gather' && candidate !== transport && candidate.route.path.length > 2) {
      const moves = candidate.route.path.length - 1;
      const maxMoves = Math.min(40, moves * 2, defense ? defense.deadlineTurn - observation.turn : Infinity);
      const proposed = planGatheringTree(observation, analysis, candidate.route.target,
        sources.map((source) => source.index), maxMoves, budget.fork(Math.floor(budget.remainingNodes / 2)), timing);
      const target = observation.tiles[candidate.route.target];
      const added = candidate.route.armies - target.armies! - production(target, observation.turn, observation.turn + moves);
      if (proposed && proposed.addedArmies / proposed.usedMoves > added / moves) {
        const purpose = evaluateTransportPlan(observation, analysis, proposed, routes,
          budget.fork(Math.floor(budget.remainingNodes / 2)), {}, timing);
        if (purpose?.canContinue && purpose.score > 0) {
          tree = proposed;
          candidate = { ...candidate, route: proposed.route, reason: `${proposed.reason};${purpose.reason}` };
        }
      }
    }
    const rejectedMissions = new Set<TaskCandidate>();
    let nextStepPath: number[] | null = null;
    while (candidate && !candidate.reason.startsWith('budget_fallback_one_step')
      && candidate.kind !== 'defend' && candidate.kind !== 'intercept') {
      const missionRoutes = tree && candidate.kind === 'gather' && candidate.route === tree.route ? tree.routes : [candidate.route];
      const assessment = assessMission(missionRoutes);
      if (assessment.status === 'unsafe') {
        if ((assessment.deadlineTurn === null || observation.generals.length > 2) && missionRoutes.length === 1
          && (assessment.reason.startsWith('mission_waiting_garrison_exposed:')
            || assessment.reason.startsWith('mission_home_outflow_after_possible_attack;'))) {
          const ready = candidate.kind === 'gather' && candidates.find((alternative) =>
            ['expand', 'scout', 'capture_city'].includes(alternative.kind)
            && alternative.route.source === candidate!.route.source && alternative.route.path.length === 2
            && assessMission([alternative.route]).status === 'safe');
          if (ready) {
            rejectedMissions.add(candidate);
            tree = null;
            candidate = { ...ready, reason: `${ready.reason};complete_visible_task_before_unverified_gather` };
            break;
          }
          const prefix = projectVisibleRoute(observation, candidate.route.path.slice(0, 2), candidate.route.half, budget)?.route;
          const nextStep = prefix && assessMission([prefix]);
          if (prefix && nextStep?.status === 'safe' && nextStep.deadlineTurn === null && nextStep.returnRoute === null) {
            nextStepPath = candidate.route.path;
            tree = null;
            candidate = { ...candidate, route: prefix,
              reason: `${candidate.reason};mission_next_step_only;prefix_verified;goal_unverified;future_garrison_unavailable;reobserve_after_step;${nextStep.reason}` };
            break;
          }
        }
        if (missionRoutes.length === 1 && !candidate.route.unknown) {
          const route = candidate.route;
          const alternatives = searchRouteAlternatives(observation, route.source, route.target,
            Math.max(route.source === analysis.home ? analysis.homeReserve : 1, strategyReserve(observation, intent, route.source)),
            budget.fork(Math.floor(budget.remainingNodes / 2)), {
              timing, maxTurns: Math.min(40, route.path.length + 3,
                assessment.deadlineTurn === null ? Infinity : assessment.deadlineTurn - observation.turn),
              ownedOnly: candidate.kind === 'gather',
            });
          const alternative = alternatives.routes.find((option) => !option.path.slice(1, -1).includes(analysis.home)
            && option.path.join(',') !== route.path.join(',')
            && !checkTask(candidate!.kind, [option])
            && assessMission([option]).status === 'safe');
          if (alternative) {
            candidate = { ...candidate, route: alternative,
              reason: `${candidate.reason};safe_route_alternative;search_complete:${alternatives.complete}` };
            tree = null;
            break;
          }
        }
        rejectedMissions.add(candidate);
        if (candidate.kind === 'gather' || candidate === continuation) {
          this.commitment = null; this.gatheringPlan = null; tree = null; continuation = null;
        }
        if (assessment.deadlineTurn === null || observation.generals.length > 2
          && /^mission_(waiting_source_exposed|waiting_garrison_exposed|route_collision):/.test(assessment.reason)) {
          candidate = candidates.find((alternative) => !rejectedMissions.has(alternative)) ?? null;
          continue;
        }
        // The assessed return starts after the proposed mission; only a current-map route can be sent.
        const route = defense?.route ?? findReturnRoute(observation, candidate.route.source, analysis.home, budget,
          assessment.deadlineTurn === null ? Infinity : assessment.deadlineTurn - observation.turn);
        candidate = route && route.path.length > 1
          ? { route, kind: 'defend', score: 1100, reason: `mission_recalled;${assessment.reason}` } : null;
      } else candidate.reason += `;${assessment.reason}`;
      break;
    }
    if (candidate && rejectedMissions.size) candidate.reason += `;avoided_unsafe_routes:${rejectedMissions.size}`;
    if ((!candidate || candidate.score < 40) && budget.timeAvailable()) {
      const screen = bottleneckScreen(observation, analysis, budget);
      if (screen) {
        candidate = { route: screen, kind: 'intercept', score: 40,
          reason: 'bottleneck_half_army_screen;all_visible_threat_routes_cross_screen;combined_garrisons_cover_visible_enemy_armies' };
        nextStepPath = null;
      }
    }
    if (intent && candidate) {
      const plan = tree && candidate.kind === 'gather' && candidate.route === tree.route ? tree.routes
        : candidate.kind === 'defend' && candidate.route === defense?.route && defenseRoutes.length
          ? defenseRoutes
          : [candidate.route];
      const rejected = checkStrategyRoutes(observation, intent, plan)
        ?? checkTask(candidate.kind, nextStepPath ? [{ path: nextStepPath }] : plan)
        ?? checkStrategyMove(observation, intent, { from: candidate.route.source, to: candidate.route.path[1], half: candidate.route.half });
      if (rejected) {
        candidate = candidates.find((alternative) => !rejectedMissions.has(alternative)
          && !checkStrategyRoutes(observation, intent, [alternative.route])
          && !checkTask(alternative.kind, [alternative.route])
          && (alternative.kind === 'intercept'
            || assessMission([alternative.route]).status !== 'unsafe'))
          ?? constrainedFallback();
        tree = null;
        nextStepPath = null;
        this.commitment = null;
        this.gatheringPlan = null;
        if (candidate) candidate.reason += `;rejected_plan:${rejected}`;
      }
    }
    if ((!candidate || candidate.score < 0) && recovery) {
      candidate = recovery; tree = null; nextStepPath = null;
    }
    const search = { nodes: budget.nodes, elapsedMs: performance.now() - startedAt,
      fallback: candidate?.reason.startsWith('budget_fallback_one_step') ?? false };
    const strategicGuard = analysis.strategicHomeDemands?.length
      ? `;strategic_general_players:${[...new Set(analysis.strategicHomeDemands.map((demand) => demand.owner))].join(',')}`
        + ';assumption:distant_general_garrisons_not_home_deadlines' : '';
    const historyGuard = strategicGuard + (analysis.possibleThreats.length
      ? `;history_guard:${analysis.possibleThreats.slice(0, 4).map((threat) => `${threat.tile}@${threat.lastSeenTurn}`).join(',')};assumption:recent_hidden_or_departed_army_may_approach_general` : '');
    if ((!candidate || candidate.score < 0) && gatherTarget !== null && observation.tiles[gatherTarget].armies! > 1
      && !defense) return { ...wait('strategy_gather_target_held;no_safe_reinforcement_selected' + historyGuard), search };
    if (!candidate || candidate.score < 0) return { ...wait((defense?.reason
      ?? (analysis.threats.length ? 'no_safe_reinforcement_or_interception' : 'building_marching_force')) + historyGuard), search };
    const route = candidate.route;
    const source = observation.tiles[route.source], target = observation.tiles[route.path[1]];
    const sentArmies = route.half ? Math.floor(source.armies! / 2) : source.armies! - 1;
    const activeTree = tree && candidate.kind === 'gather' && route === tree.route ? tree : null;
    const taskTarget = candidate.kind === 'defend' ? analysis.home
      : nextStepPath?.at(-1) ?? activeTree?.target ?? route.target;
    const displayRoutes = activeTree?.routes
      ?? (candidate.kind === 'defend' && route === defense?.route && defenseRoutes.length ? defenseRoutes : [route]);
    const plan = { routes: displayRoutes.map((leg) => ({ path: [...(nextStepPath ?? leg.path)], half: leg.half })),
      nextStepOnly: nextStepPath !== null };
    const remaining = activeTree ? [activeTree.paths[0].slice(1), ...activeTree.paths.slice(1)].filter((path) => path.length > 1) : [];
    this.gatheringPlan = remaining.length ? { paths: remaining, deadlineTurn: activeTree!.deadlineTurn } : null;
    this.commitment = { kind: candidate.kind, target: taskTarget, army: remaining[0]?.[0] ?? target.index,
      ...(candidate.kind === 'gather' || nextStepPath || candidate === continuation
        ? { path: (nextStepPath ?? route.path).slice(1) } : {}) };
    return finish({ ...base, kind: 'move', move: { from: route.source, to: target.index, half: route.half },
      task: { kind: candidate.kind, target: taskTarget }, reason: candidate.reason + historyGuard, search, plan,
      ...(target.armies === null ? {} : { prediction: { sentArmies,
        remainingArmies: target.owner === observation.playerIndex ? target.armies + sentArmies : Math.max(0, sentArmies - target.armies) } }) });
  }
}
