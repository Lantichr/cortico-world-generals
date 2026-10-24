import { describe, expect, it } from 'vitest';
import type { AgentObservation, AgentReport } from '../../src/agent/contracts.ts';
import { createStrategyBrief } from '../../src/agent/report.ts';
import { IntentController, STRATEGY_ANCHOR_PROPERTIES, STRATEGY_INTENT_PROPERTIES } from '../../src/intent.ts';
import { GENERALS_ARMY_LIMITS } from '../../src/state.ts';
import { createTools } from '../../scripts/llm-suite/tools.ts';

function fixture() {
  const owners = [2, 2, 1, null, 2, 0, null, null];
  const tiles = [8, 30, 40, 0, 30, 20, null, null].map((armies, index) => ({
    index, x: index % 4, y: Math.floor(index / 4), visible: index < 6,
    terrain: index < 6 ? owners[index] ?? -1 : -3, owner: owners[index], armies,
    general: index < 6 ? index === 0 : null, city: index < 6 ? index === 1 : null, tunnelLimit: index < 6 ? 0 : null,
  }));
  const observation: AgentObservation = { gameId: 'suite-tools', controlEpoch: 1, revision: 20, turn: 19,
    playerIndex: 2, width: 4, height: 2, tiles, generals: [-1, -1, 0],
    history: tiles.map((tile, index) => index < 6 ? { ...tile, lastSeenTurn: 19 } : null),
    scores: [{ i: 0, total: 20, tiles: 1 }, { i: 1, total: 900, tiles: 4 }, { i: 2, total: 68, tiles: 3 }] };
  observation.history[6] = { ...tiles[6], visible: true, terrain: 1, owner: 1, armies: 600,
    general: true, city: true, tunnelLimit: 0, lastSeenTurn: 7 };
  const intents = new IntentController();
  const status = (): AgentReport => ({ gameId: observation.gameId, controlEpoch: observation.controlEpoch,
    control: 'autonomous', operatorPaused: false, operatorPauseLinked: false, phase: 'playing',
    observedTurn: observation.turn, method: 'bounded_rule_search', activeIntentRevision: intents.snapshot().active?.revision ?? null,
    supportedRules: 'standard_or_city_state_ffa', error: null, lastDecision: null, pendingAction: null, lastFeedback: null,
    intent: intents.snapshot() });
  const tools = createTools({ observation: () => observation, status, brief: () => createStrategyBrief(observation, status()), intents });
  const intent = (revision = 1) => ({ gameId: observation.gameId, controlEpoch: observation.controlEpoch,
    revision, basedOnTurn: observation.turn, expiresTurn: observation.turn + 40,
    goal: { kind: 'gather', target: { x: 1, y: 0 } }, constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 5 }] } });
  return { observation, intents, tools, intent };
}

describe('standalone S2 tools', () => {
  it('keeps fog armies out of observations and rankings while dating last-seen facts', () => {
    const { tools } = fixture();
    const raw = tools.execute('generals_observe', {}) as { armies: unknown[]; cities: number[]; selfTiles: unknown[] };
    expect(raw.armies).toEqual([8, 30, 40, 0, 30, 20, null, null]);
    expect(raw.cities).toEqual([1]);
    const ranks = tools.execute('generals_list_armies', { side: 'enemy' }) as { groups: { enemy: unknown[] } };
    expect(ranks.groups.enemy).toEqual([
      { x: 2, y: 0, owner: 1, armies: 40, general: false, city: false },
      { x: 1, y: 1, owner: 0, armies: 20, general: false, city: false },
    ]);
    expect(tools.execute('generals_inspect_tiles', { tiles: [6, { x: 3, y: 1 }] })).toMatchObject({
      playerIndex: 2, observedTurn: 19, tiles: [
        { current: { visible: false, armies: null, owner: null }, lastSeen: { armies: 600, owner: 1, lastSeenTurn: 7 } },
        { current: { visible: false }, lastSeen: null },
      ],
    });
    const compact = tools.execute('generals_observe', { format: 'compact' }) as { grid: string; playerLegend: string };
    expect(compact.grid).toContain('?~GC ?');
    expect(compact.grid).not.toContain('600');
    expect(compact.playerLegend).toContain('p2 self');
  });

  it('uses the self player id and stable row-major ordering with per-group limits', () => {
    const { tools } = fixture();
    expect(tools.execute('generals_list_armies', { limit: 2 })).toMatchObject({
      limit: 2, side: 'self', groups: { self: [
        { x: 1, y: 0, owner: 2, armies: 30 }, { x: 0, y: 1, owner: 2, armies: 30 },
      ] },
    });
    expect(tools.execute('generals_list_armies', { side: 'all', limit: 1 })).toMatchObject({
      groups: { self: [{ owner: 2, armies: 30 }], enemy: [{ owner: 1, armies: 40 }], allies: [], unknown: [] },
    });
    expect(tools.execute('generals_list_armies', {})).toMatchObject({ limit: GENERALS_ARMY_LIMITS.default });
    expect(tools.execute('generals_list_armies', { limit: GENERALS_ARMY_LIMITS.max + 1 })).toMatchObject({ ok: false });
  });

  it('applies an intent through current facts and preserves an existing intent on rejection', () => {
    const { tools, intents, intent, observation } = fixture();
    const original = intent();
    expect(tools.execute('generals_set_intent', original)).toMatchObject({ intent: { status: 'following', lastRevision: 1 } });
    observation.turn += 3;
    observation.tiles[1].owner = 1;
    const staleTarget = intent(2);
    expect(tools.execute('generals_set_intent', staleTarget)).toEqual({ ok: false, error: 'intent_target_must_be_owned' });
    expect(intents.snapshot().active).toEqual(original);
    expect(intents.snapshot().lastRejection).toEqual({ revision: 2, reason: 'intent_target_must_be_owned', atTurn: observation.turn });
    const delayed = { ...intent(2), gameId: 'previous-game', basedOnTurn: original.basedOnTurn };
    delayed.goal = { kind: 'gather', target: { x: 0, y: 0 } };
    expect(tools.execute('generals_set_intent', delayed)).toEqual({ ok: false, error: 'intent_wrong_game' });
    expect(delayed.gameId).toBe('previous-game');
    expect(delayed.basedOnTurn).toBe(original.basedOnTurn);
    expect(tools.execute('generals_set_intent', { ...delayed, gameId: observation.gameId })).toMatchObject({
      intent: { active: { revision: 2 }, lastRevision: 2 },
    });
    expect(intents.snapshot().active?.basedOnTurn).toBe(original.basedOnTurn);
  });

  it('rejects stale clears and requires an increasing revision to release constraints', () => {
    const { tools, intents, intent } = fixture();
    const args = intent();
    tools.execute('generals_set_intent', args);
    expect(tools.execute('generals_clear_intent', { gameId: args.gameId, controlEpoch: args.controlEpoch, revision: 1 }))
      .toEqual({ ok: false, error: 'intent_stale_revision' });
    expect(intents.snapshot().active?.constraints).toEqual(args.constraints);
    expect(tools.execute('generals_clear_intent', { gameId: args.gameId, controlEpoch: args.controlEpoch, revision: 2 }))
      .toMatchObject({ intent: { status: 'cancelled', active: null, lastRevision: 2 } });
  });

  it('returns isolated snapshots and reports malformed calls without interrupting the runner', () => {
    const { tools, observation } = fixture();
    const raw = tools.execute('generals_observe', {}) as { armies: unknown[]; selfGeneral: { armies: number } };
    raw.armies[0] = 10000;
    raw.selfGeneral.armies = 10000;
    expect(observation.tiles[0].armies).toBe(8);
    for (const [name, args] of [
      ['generals_move', {}], ['generals_strategy_brief', { extra: true }], ['generals_observe', { format: 'other' }],
      ['generals_inspect_tiles', { tiles: [{ x: 99, y: 0 }] }], ['generals_inspect_tiles', { tiles: [] }],
      ['generals_list_armies', { limit: null }], ['generals_list_armies', { side: null }],
    ] as const) expect(tools.execute(name, args)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(tools.execute('generals_agent_status', null as unknown as Record<string, unknown>))
      .toEqual({ ok: false, error: 'tool_arguments_must_be_object' });
  });

  it('declares the production intent schemas and offers no direct movement or account tools', () => {
    const { tools } = fixture();
    const declarations = new Map(tools.declarations.map((tool) => [tool.function.name, tool.function.parameters]));
    expect(declarations.get('generals_set_intent')?.properties).toEqual(STRATEGY_INTENT_PROPERTIES);
    expect(declarations.get('generals_clear_intent')?.properties).toEqual(STRATEGY_ANCHOR_PROPERTIES);
    expect([...declarations.keys()]).toEqual([
      'generals_strategy_brief', 'generals_agent_status', 'generals_observe', 'generals_inspect_tiles',
      'generals_list_armies', 'generals_set_intent', 'generals_clear_intent',
    ]);
  });
});
