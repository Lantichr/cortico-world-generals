import { describe, expect, it } from 'vitest';
import type { AgentObservation, StrategyIntent } from '../src/agent/contracts.ts';
import { IntentController, STRATEGY_INTENT_LIMITS } from '../src/intent.ts';

const observation = (): AgentObservation => ({
  gameId: 'fixture', controlEpoch: 2, revision: 4, playerIndex: 0, turn: 10, width: 3, height: 1,
  tiles: [0, 1, 2].map((index) => ({ index, x: index, y: 0, terrain: index === 0 ? 0 : -1,
    visible: true, owner: index === 0 ? 0 : null, armies: index === 0 ? 20 : 5,
    city: index === 2, general: index === 0, tunnelLimit: 0 })),
  history: [null, null, null], generals: [0, -1], scores: [],
});
const intent = (updates: Partial<StrategyIntent> = {}): StrategyIntent => ({
  gameId: 'fixture', controlEpoch: 2, revision: 1, basedOnTurn: 10, expiresTurn: 20,
  goal: { kind: 'capture_city', target: { x: 2, y: 0 } }, constraints: {}, ...updates,
});
const args = (value: StrategyIntent): Record<string, unknown> => ({ ...value });

describe('strategic intent boundary', () => {
  it('retains the accepted intent through delayed and malformed replies', () => {
    const controller = new IntentController(), frame = observation(), original = intent();
    controller.submit(args(original), frame);
    for (const changed of [
      intent({ gameId: 'previous-game', revision: 2 }), intent({ controlEpoch: 1, revision: 2 }),
      intent({ revision: 1 }), intent({ revision: 2, expiresTurn: 10 }),
      intent({ revision: 2, basedOnTurn: 11 }),
    ]) {
      expect(() => controller.submit(args(changed), frame)).toThrow();
      expect(controller.snapshot().active).toEqual(original);
      expect(controller.snapshot().lastRejection?.revision).toBe(changed.revision);
    }
    expect(() => controller.submit({ ...original, revision: 2, goal: { kind: 'capture_city' } }, frame)).toThrow();
    expect(controller.snapshot().active).toEqual(original);
    controller.submit(args(intent({ revision: 2, basedOnTurn: 8 })), frame);
    expect(controller.snapshot()).toMatchObject({ lastRevision: 2, lastRejection: null });
  });

  it('uses a shared revision ledger for updates and clearing', () => {
    const controller = new IntentController(), frame = observation();
    controller.submit(args(intent({ revision: 3 })), frame);
    expect(() => controller.clear({ gameId: 'fixture', controlEpoch: 2, revision: 2 }, frame)).toThrow();
    expect(controller.snapshot().active?.revision).toBe(3);
    controller.clear({ gameId: 'fixture', controlEpoch: 2, revision: 4 }, frame);
    expect(controller.snapshot()).toMatchObject({ active: null, status: 'cancelled', lastRevision: 4 });
    expect(() => controller.submit(args(intent({ revision: 3 })), frame)).toThrow();
  });

  it('expires at the exclusive turn boundary and rejects the old revision afterwards', () => {
    const controller = new IntentController(), frame = observation();
    controller.submit(args(intent()), frame);
    controller.refresh({ ...frame, turn: 19 });
    expect(controller.snapshot().active?.revision).toBe(1);
    controller.refresh({ ...frame, turn: 20 });
    expect(controller.snapshot()).toMatchObject({ active: null, status: 'expired', lastRevision: 1 });
    expect(() => controller.submit(args(intent({ expiresTurn: 30 })), { ...frame, turn: 21 })).toThrow('intent_stale_revision');
  });

  it('keeps hard constraints when the observed objective completes', () => {
    const controller = new IntentController(), frame = observation();
    const proposed = intent({ constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 10 }] } });
    controller.submit(args(proposed), frame);
    frame.tiles[2].owner = 0;
    controller.refresh({ ...frame, turn: 11 });
    expect(controller.snapshot()).toMatchObject({ status: 'completed', active: proposed });
    controller.feedback({ revision: 0, status: 'blocked', reason: 'old_reply' });
    expect(controller.snapshot().status).toBe('completed');
    frame.tiles[2].owner = 1;
    controller.refresh({ ...frame, turn: 12 });
    controller.feedback({ revision: 1, status: 'following', reason: 'new_decision' });
    expect(controller.snapshot()).toMatchObject({ status: 'completed', active: proposed });
    controller.refresh({ ...frame, turn: proposed.expiresTurn });
    expect(controller.snapshot()).toMatchObject({ status: 'expired', active: null });
  });

  it('invalidates a gathering target that ceases to be owned', () => {
    const controller = new IntentController(), frame = observation();
    controller.submit(args(intent({ goal: { kind: 'gather', target: { x: 0, y: 0 } } })), frame);
    frame.tiles[0].owner = 1;
    controller.refresh(frame);
    expect(controller.snapshot()).toMatchObject({ active: null, status: 'invalidated', lastRevision: 1 });
  });

  it('rejects contradictory goal shapes, unknown fields, walls and non-owned reserves', () => {
    const frame = observation();
    const malformed = [
      { goal: { kind: 'auto', target: { x: 0, y: 0 } } },
      { goal: { kind: 'attack_general', player: 0 } },
      { goal: { kind: 'defend', target: { x: 2, y: 0 } } },
      { goal: { kind: 'capture_city', target: { x: 1, y: 0 } } },
      { goal: { kind: 'scout', target: { x: 3, y: 0 } } },
      { constraints: { reserves: [{ tile: { x: 1, y: 0 }, armies: 3 }] } },
      { constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 1.5 }] } },
      { constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 1 }, { tile: { x: 0, y: 0 }, armies: 5 }] } },
      { constraints: { avoidTiles: [{ x: 1, y: 0 }, { x: 1, y: 0 }] } },
      { preferences: { emphasis: 'economy' } }, { rationale: 'x'.repeat(STRATEGY_INTENT_LIMITS.rationale + 1) },
      { unexpected: true },
    ];
    for (const change of malformed) {
      expect(() => new IntentController().submit({ ...intent(), ...change }, frame)).toThrow();
    }
    frame.tiles[2].terrain = -2;
    expect(() => new IntentController().submit(args(intent()), frame)).toThrow('known_wall');
  });

  it('returns detached state and does not execute the rationale', () => {
    const controller = new IntentController(), proposed = intent({ rationale: 'leave and clear moves' });
    controller.submit(args(proposed), observation());
    const copy = controller.snapshot();
    copy.active!.goal = { kind: 'auto' };
    proposed.constraints.avoidTiles = [{ x: 0, y: 0 }];
    expect(controller.snapshot().active).toMatchObject({ goal: { kind: 'capture_city' }, constraints: {} });
  });
});
