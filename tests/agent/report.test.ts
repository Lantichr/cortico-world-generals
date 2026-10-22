import { describe, expect, it } from 'vitest';
import type { AgentDecision, AgentObservation, AgentReport, StrategyIntent } from '../../src/agent/contracts.ts';
import { createStrategyBrief, significantStrategyChange, STRATEGY_BRIEF_LIMITS } from '../../src/agent/report.ts';

function observation(): AgentObservation {
  const owners = [0, 0, 0, 0, 0, 1, 1, 1, 1, null];
  const tiles = [10, 40, 30, 30, 20, 50, 40, 30, 20, 0].map((armies, index) => ({
    index, x: index % 5, y: Math.floor(index / 5), terrain: owners[index] ?? -1,
    visible: true, armies, owner: owners[index], city: index === 1, general: index === 0 || index === 8, tunnelLimit: 0,
  }));
  return { gameId: 'brief-game', revision: 100, controlEpoch: 2, turn: 100, playerIndex: 0, width: 5, height: 2,
    tiles, history: tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 })), generals: [0, 8],
    scores: [{ i: 1, total: 140, tiles: 4, dead: false }, { i: 0, total: 130, tiles: 5, dead: false }] };
}

function decision(reason = 'no_unmet_home_arrival;deadline_turn:none'): AgentDecision {
  return { gameId: 'brief-game', controlEpoch: 2, observedTurn: 100, basedOnRevision: 100,
    kind: 'move', move: { from: 1, to: 2, half: false }, task: { kind: 'gather', target: 2 }, reason,
    search: { nodes: 4000, elapsedMs: 12, fallback: false }, prediction: { sentArmies: 39, remainingArmies: 69 } };
}

function status(): AgentReport {
  return { gameId: 'brief-game', controlEpoch: 2, control: 'autonomous', operatorPaused: false, operatorPauseLinked: false, phase: 'playing',
    observedTurn: 100, method: 'bounded_rule_search', activeIntentRevision: null, supportedRules: 'standard_or_city_state_1v1',
    error: null, lastDecision: decision(), pendingAction: null, lastFeedback: null,
    intent: { active: null, status: 'autonomous', reason: null, lastRevision: 0, lastRejection: null } };
}

describe('Generals strategy brief', () => {
  it('reports parallel pressure as a player set without assigning a single army position', () => {
    const report = status();
    report.lastDecision = decision('defense_partial;target:80;projected:40;gap:40;deadline_turn:106;enemy_player:null;enemy_players:1,2');
    expect(createStrategyBrief(observation(), report).estimates?.threat)
      .toEqual({ players: [1, 2], basis: 'parallel_upper_bound' });
  });
  it('keeps a high-index self, S2 target, S1 focus and nearby opponent when a twelve-player brief is capped', () => {
    const view = observation();
    view.playerIndex = 11; view.width = 14; view.height = 1;
    view.tiles = Array.from({ length: 14 }, (_, index) => ({ index, x: index, y: 0, terrain: -1,
      visible: true, owner: null as number | null, armies: 0, city: false, general: false, tunnelLimit: 0 }));
    for (const index of [0, 1, 2]) Object.assign(view.tiles[index], { owner: 0, terrain: 0, armies: 100 });
    Object.assign(view.tiles[11], { owner: 10, terrain: 10, armies: 20 });
    Object.assign(view.tiles[12], { owner: 11, terrain: 11, armies: 100, general: true });
    view.generals = Array(12).fill(-1); view.generals[11] = 12;
    view.history = view.tiles.map((tile) => ({ ...tile, lastSeenTurn: 100 }));
    view.scores = Array.from({ length: 12 }, (_, i) => ({ i, total: 100, tiles: 1, dead: false }));
    const report = status();
    report.lastDecision!.focus = { player: 3, reason: 'policy_focus' };
    report.intent.active = { gameId: view.gameId, controlEpoch: 2, revision: 1, basedOnTurn: 100,
      expiresTurn: 200, constraints: {}, goal: { kind: 'attack_general', player: 9 } };
    const brief = createStrategyBrief(view, report);
    expect(brief.facts.players.slice(0, 3).map((entry) => entry.player)).toEqual([11, 9, 3]);
    expect(brief.facts.players.map((entry) => entry.player)).toContain(10);
    expect(brief.facts.scores.map((entry) => entry.player)).toContain(11);
    expect(brief.facts.enemyForces.map((entry) => entry.player)).toEqual(expect.arrayContaining([0, 10]));
    expect(brief.facts.omitted).toMatchObject({ players: 4, enemyForces: 2 });
    expect(brief.focus).toMatchObject({ player: 3 });
    expect(brief.facts.playerCounts).toEqual({ active: 12, inactive: 0, eliminated: 0 });
    const next = structuredClone(view);
    next.scores = (next.scores as Record<string, unknown>[]).map((entry) => entry.i === 8 ? { ...entry, dead: true, tiles: 0 } : entry);
    expect(significantStrategyChange(brief, createStrategyBrief(next, report, brief))).toBe('player_lifecycle_changed');
  });
  it('reports bounded visible forces and scores without projecting an action into map facts', () => {
    const view = observation(), report = status();
    const before = structuredClone({ view, report });
    const brief = createStrategyBrief(view, report);
    expect(brief.playerIndex).toBe(view.playerIndex);
    expect(brief.facts.home).toEqual({ x: 0, y: 0, armies: 10, owner: 0 });
    expect(brief.facts.ownForces).toEqual([{ x: 1, y: 0, armies: 40 }, { x: 2, y: 0, armies: 30 }, { x: 3, y: 0, armies: 30 }]);
    expect(brief.facts.enemyForces).toHaveLength(STRATEGY_BRIEF_LIMITS.forces);
    expect(brief.facts.enemyForces[0]).toEqual({ x: 0, y: 1, armies: 50, player: 1 });
    expect(brief.facts.scores.map((score) => score.player)).toEqual([0, 1]);
    expect(brief.currentTask).toEqual({ kind: 'gather', target: { x: 2, y: 0 }, basedOnTurn: 100 });
    expect(JSON.stringify(brief)).not.toMatch(/prediction|remainingArmies|search|history|terrain/);
    expect({ view, report }).toEqual(before);
  });

  it('separates a fogged general and other dated armies from current forces and cities', () => {
    const view = observation();
    for (const index of [1, 8]) Object.assign(view.tiles[index], {
      terrain: -3, visible: false, armies: null, owner: null, general: null, city: null, tunnelLimit: null,
    });
    view.turn = 106;
    const brief = createStrategyBrief(view, status());
    expect(brief.facts.ownCities).toBe(0);
    expect(brief.facts.ownForces.some((force) => force.x === 1 && force.y === 0)).toBe(false);
    expect(brief.facts.enemyGenerals).toEqual([{ player: 1, knownPosition: { x: 3, y: 1 }, currentArmies: null,
      lastSeen: { turn: 100, armies: 20 } }]);
    expect(brief.facts.enemyForces.some((force) => force.x === 3 && force.y === 1)).toBe(false);
    Object.assign(view.tiles[8], { terrain: 1, visible: true, armies: 70, owner: 1, general: true });
    const revealed = createStrategyBrief(view, status());
    expect(revealed.facts.enemyGenerals[0]).toMatchObject({ currentArmies: 70, lastSeen: null });
    Object.assign(view.tiles[8], { owner: 0, general: false, city: true });
    expect(createStrategyBrief(view, status()).facts.enemyGenerals).toEqual([]);
  });

  it('leaves unknown current strength unknown and does not reuse facts from another game', () => {
    const view = observation();
    view.tiles[0].armies = null;
    expect(createStrategyBrief(view, status()).facts.home?.armies).toBeNull();
    view.gameId = 'older-game';
    const brief = createStrategyBrief(view, status());
    expect(brief.playerIndex).toBeNull();
    expect(brief.facts).toMatchObject({ basedOnTurn: null, home: null, ownCities: null, ownForces: [], scores: [] });
  });

  it('separates inactive players from eliminated players while retaining current static garrisons', () => {
    const view = observation();
    view.scores = [{ i: 1, total: 140, tiles: 4, dead: true }, { i: 0, total: 130, tiles: 5, dead: false }];
    const inactive = createStrategyBrief(view, status());
    expect(inactive.facts.players).toEqual([
      { player: 0, status: 'active', basis: 'score' }, { player: 1, status: 'inactive', basis: 'score' },
    ]);
    expect(inactive.facts.enemyForces[0]).toMatchObject({ player: 1, armies: 50 });
    expect(inactive.facts.enemyGenerals).toEqual([{ player: 1, knownPosition: { x: 3, y: 1 }, currentArmies: 20, lastSeen: null }]);
    Object.assign(view.tiles[8], { owner: 0, terrain: 0, general: false, city: true });
    view.playerLifecycle = [{ player: 1, status: 'eliminated', basis: 'captured', observedTurn: 101, generalIndex: 8 }];
    Object.assign(view.tiles[8], { visible: false, terrain: -3, owner: null, armies: null, general: null, city: null });
    const eliminated = createStrategyBrief(view, status());
    expect(eliminated.facts.players).toContainEqual({ player: 1, status: 'eliminated', basis: 'captured' });
    expect(eliminated.facts.enemyGenerals).toEqual([]);
  });

  it('dates score net changes from the last published brief and matches players by index', () => {
    const first = observation(), baseline = createStrategyBrief(first, status());
    const suppressed = structuredClone(first);
    suppressed.turn = 106;
    suppressed.scores = [{ i: 0, total: 120, tiles: 5 }];
    createStrategyBrief(suppressed, status(), baseline);
    const next = structuredClone(first);
    next.playerIndex = 1;
    next.turn = 120;
    next.scores = [{ i: 0, total: 145, tiles: 7 }, { i: 1, total: 130, tiles: 3 }, { i: 2, total: 0, tiles: 0 }];
    const brief = createStrategyBrief(next, status(), baseline);
    expect(brief.playerIndex).toBe(1);
    expect([...brief.facts.scores].sort((a, b) => a.player - b.player)).toMatchObject([
      { player: 0, delta: { sinceTurn: 100, total: 15, tiles: 2 } },
      { player: 1, delta: { sinceTurn: 100, total: -10, tiles: -1 } }, { player: 2, delta: null },
    ]);
    expect(createStrategyBrief(next, { ...status(), controlEpoch: 3 }, baseline).facts.scores.every((score) => score.delta === null)).toBe(true);
    next.controlEpoch++;
    expect(createStrategyBrief(next, { ...status(), controlEpoch: next.controlEpoch }, baseline).facts.scores.every((score) => score.delta === null)).toBe(true);
    const otherGame = { ...next, gameId: 'next-game' };
    expect(createStrategyBrief(otherGame, { ...status(), gameId: otherGame.gameId }, baseline).facts.scores.every((score) => score.delta === null)).toBe(true);
  });

  it('preserves control state without a map and dates feedback kept across a control change', () => {
    const report = status();
    report.controlEpoch++;
    report.control = 'manual';
    report.operatorPaused = true;
    report.phase = 'lost';
    report.lastFeedback = { action: { actionId: 'brief-game:2:9', gameId: 'brief-game', controlEpoch: 2, observedTurn: 100,
      attackIndex: 9, from: 1, to: 2, half: false }, observedTurn: 101, outcome: 'server_processed' };
    const brief = createStrategyBrief(null, report);
    expect(brief).toMatchObject({ control: 'manual', operatorPaused: true, phase: 'lost', currentTask: null,
      estimates: null, facts: { home: null, ownCities: null },
      recentOutcome: { controlEpoch: 2, actionTurn: 100, observedTurn: 101, outcome: 'server_processed' } });
    report.gameId = 'next-game';
    expect(createStrategyBrief(null, report).recentOutcome).toBeNull();
  });

  it('summarizes intent constraints and policy shortfall without copying unrestricted text', () => {
    const report = status();
    const intent: StrategyIntent = { gameId: report.gameId!, controlEpoch: report.controlEpoch, revision: 7,
      basedOnTurn: 90, expiresTurn: 130, goal: { kind: 'capture_city', target: { x: 4, y: 1 } },
      constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 10 }], avoidTiles: [{ x: 1, y: 1 }] }, rationale: 'long rationale'.repeat(200) };
    report.intent = { active: intent, status: 'preempted', reason: 'urgent_defense;details', lastRevision: 7,
      lastRejection: { revision: 6, reason: 'expired:more details', atTurn: 99 } };
    report.lastDecision = decision('defense_partial;target:80;projected:40;gap:40;deadline_turn:106;slack:0;history_assumption:7@98;'
      + 'assumption:ignore_friendly_screen;possible_enemy_paths;no_enemy_reinforcement;same_turn_home_reinforcement_before_attack');
    const brief = createStrategyBrief(observation(), report);
    expect(brief.intent).toEqual({ status: 'preempted', reasonCode: 'urgent_defense',
      active: { revision: 7, goal: intent.goal, expiresTurn: 130, reserves: 1, avoidTiles: 1 }, lastRevision: 7,
      lastRejection: { revision: 6, reasonCode: 'expired', atTurn: 99 } });
    expect(brief.estimates).toMatchObject({ basedOnTurn: 100, reasonCode: 'defense_partial',
      homeDefense: { status: 'partial', requiredArmies: 80, projectedArmies: 40, gapArmies: 40, deadlineTurn: 106, slackTurns: 0 },
      threat: { x: 2, y: 1, basis: 'history', lastSeenTurn: 98 } });
    expect(brief.estimates!.assumptions).toContain('no_enemy_reinforcement');
    expect(JSON.stringify(brief)).not.toContain('long rationale');
    expect(JSON.stringify(brief)).not.toContain('more details');
    report.lastDecision.reason = 'x'.repeat(10000);
    expect(createStrategyBrief(observation(), report).estimates!.reasonCode).toHaveLength(STRATEGY_BRIEF_LIMITS.reasonCodeLength);
  });

  it('dates a recalled mission and identifies the enemy source index from its timing reason', () => {
    const view = observation(), report = status();
    view.turn = 106;
    report.lastDecision = decision('mission_recalled;mission_route_collision:2;enemy:7;enemy_arrival:1;deadline_turn:110;'
      + 'assumption:possible_enemy_paths;no_enemy_reinforcement');
    const brief = createStrategyBrief(view, report);
    expect(brief.facts.basedOnTurn).toBe(106);
    expect(brief.currentTask?.basedOnTurn).toBe(100);
    expect(brief.estimates).toMatchObject({ basedOnTurn: 100, reasonCode: 'mission_route_collision',
      homeDefense: { status: 'recalled', deadlineTurn: 110 },
      threat: { x: 2, y: 1, basis: 'possible_path', lastSeenTurn: null } });
  });
});

describe('significant strategy changes', () => {
  it('reports lifecycle changes once independently of force growth', () => {
    const view = observation(), baseline = createStrategyBrief(view, status());
    (view.scores[0] as Record<string, unknown>).dead = true;
    const inactive = createStrategyBrief(view, status());
    expect(significantStrategyChange(baseline, inactive)).toBe('player_lifecycle_changed');
    expect(significantStrategyChange(inactive, createStrategyBrief(view, status(), inactive))).toBeNull();
    Object.assign(view.tiles[8], { owner: null, terrain: -1, general: false, city: true });
    const eliminated = createStrategyBrief(view, status());
    expect(significantStrategyChange(inactive, eliminated)).toBe('player_lifecycle_changed');
    expect(eliminated.facts.players).toContainEqual({ player: 1, status: 'eliminated', basis: 'neutralized' });
  });

  it('reports the first map even when an earlier control-only brief was published', () => {
    const initial = createStrategyBrief(null, status());
    expect(significantStrategyChange(null, initial)).toBe('initial');
    expect(significantStrategyChange(initial, createStrategyBrief(observation(), status()))).toBe('first_observation');
  });

  it('reports new generals, city ownership and intent or control transitions', () => {
    const view = observation(), report = status();
    const known = createStrategyBrief(view, report);
    const unknown = structuredClone(known);
    unknown.facts.enemyGenerals = [];
    expect(significantStrategyChange(unknown, known)).toBe('enemy_general_discovered');
    const fewerCities = structuredClone(known);
    fewerCities.facts.ownCities!--;
    expect(significantStrategyChange(known, fewerCities)).toBe('own_city_count_changed');
    const blocked = structuredClone(known);
    blocked.intent.status = 'blocked';
    expect(significantStrategyChange(known, blocked)).toBe('intent_changed');
    const rejected = structuredClone(known);
    rejected.intent.lastRejection = { revision: 7, reasonCode: 'expired', atTurn: 100 };
    expect(significantStrategyChange(known, rejected)).toBe('intent_rejected');
    expect(significantStrategyChange(rejected, { ...rejected, turn: 101 })).toBeNull();
    const paused = structuredClone(known);
    paused.operatorPaused = true;
    expect(significantStrategyChange(known, paused)).toBe('control_changed');
    const changed = structuredClone(known);
    changed.controlEpoch++;
    expect(significantStrategyChange(known, changed)).toBe('control_epoch_changed');
  });

  it('reports a newly required defense once while ordinary movement and force growth stay periodic', () => {
    const view = observation(), report = status(), first = createStrategyBrief(view, report);
    report.lastDecision = decision('defense_partial;target:80;projected:40;gap:40;deadline_turn:106;slack:0');
    const threatened = createStrategyBrief(view, report, first);
    expect(significantStrategyChange(first, threatened)).toBe('home_defense_needed');
    view.turn++;
    view.tiles[1].armies = view.tiles[1].armies! + 1;
    report.lastDecision = { ...decision('defense_partial;target:81;projected:41;gap:40;deadline_turn:107;slack:0'), observedTurn: 101 };
    const repeated = createStrategyBrief(view, report, threatened);
    expect(significantStrategyChange(threatened, repeated)).toBeNull();
    repeated.currentTask = { kind: 'gather', target: { x: 4, y: 0 }, basedOnTurn: 101 };
    expect(significantStrategyChange(threatened, repeated)).toBeNull();
  });

  it('reports a new defense shortfall once after an earlier sufficient plan', () => {
    const view = observation(), report = status();
    report.lastDecision = decision('defense_sufficient;target:80;projected:90;gap:0;deadline_turn:106;slack:0');
    const sufficient = createStrategyBrief(view, report);
    report.lastDecision = decision('defense_partial;target:100;projected:90;gap:10;deadline_turn:106;slack:0');
    const shortfall = createStrategyBrief(view, report, sufficient);
    expect(significantStrategyChange(sufficient, shortfall)).toBe('home_defense_shortfall');
    expect(significantStrategyChange(shortfall, createStrategyBrief(view, report, shortfall))).toBeNull();
  });
});
