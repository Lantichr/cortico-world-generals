import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GENERALS_DEFAULTS } from '../../src/config.ts';
import { CityHalfAgent } from '../../src/agent/city-half.ts';
import type { AgentObservation, StrategyIntentState } from '../../src/agent/contracts.ts';
import { PythonChannel } from '../../src/agent/python-channel.ts';

const autonomous: StrategyIntentState = { active: null, status: 'autonomous', reason: null, lastRevision: 0, lastRejection: null };
const observation = (turn: number, players = 2): AgentObservation => ({
  gameId: 'fixture', controlEpoch: 1, revision: turn, playerIndex: 0, turn, width: 5, height: 5,
  tiles: Array.from({ length: 25 }, (_, index) => ({ index, x: index % 5, y: Math.floor(index / 5),
    terrain: index === 0 || index === 1 ? 0 : index === 24 ? 1 : -1,
    visible: true, owner: index === 0 || index === 1 ? 0 : index === 24 ? 1 : null,
    armies: index === 0 ? 30 : index === 1 ? 8 : index === 24 ? 5 : 0,
    general: index === 0 || index === 24, city: false, tunnelLimit: 0 })),
  history: Array(25).fill(null), generals: [0, 24, ...Array(players - 2).fill(-1)],
  scores: Array.from({ length: players }, (_, i) => ({ i, total: i === 0 ? 38 : 5, tiles: i === 0 ? 2 : 1, dead: false })),
});

describe('packaged city-half-1 Python policy', () => {
  const agents: CityHalfAgent[] = [];
  const create = () => { const agent = new CityHalfAgent(GENERALS_DEFAULTS.agent); agents.push(agent); return agent; };
  afterEach(async () => { await Promise.all(agents.splice(0).map((agent) => agent.close())); });

  it('passes its movement, lifecycle, constraints and persistent-task regressions without pip dependencies', () => {
    const result = spawnSync(GENERALS_DEFAULTS.agent.pythonExecutable, ['-I', '-B', '-m', 'unittest', 'discover',
      '-s', fileURLToPath(new URL('../city-half/', import.meta.url)), '-p', 'test_*.py'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 35_000);

  it.each([2, 4])('plays autonomously with %i players and reports native execution', async (players) => {
    const agent = create();
    await agent.decide(observation(1, players), autonomous);
    const { decision, feedback } = await agent.decide(observation(2, players), autonomous);
    expect(decision.kind).toBe('move');
    expect(decision.execution).toMatchObject({ mode: 'native_auto' });
    expect(feedback).toBeNull();
    expect(decision).toMatchObject({ gameId: 'fixture', controlEpoch: 1, basedOnRevision: 2 });
  });

  it('follows a gather intent and keeps explicit reserves on every proposed departure', async () => {
    const agent = create();
    await agent.decide(observation(1), autonomous);
    const strategy: StrategyIntentState = { ...autonomous, status: 'following', lastRevision: 1,
      active: { gameId: 'fixture', controlEpoch: 1, revision: 1, basedOnTurn: 1, expiresTurn: 30,
        goal: { kind: 'gather', target: { x: 1, y: 0 } }, constraints: { reserves: [{ tile: { x: 0, y: 0 }, armies: 12 }] } } };
    const { decision, feedback } = await agent.decide(observation(2), strategy);
    expect(feedback).toMatchObject({ revision: 1, status: 'following' });
    expect(decision).toMatchObject({ kind: 'move', task: { kind: 'gather', target: 1 }, move: { from: 0, to: 1, half: true } });
    expect(decision.prediction?.remainingArmies).toBeGreaterThanOrEqual(12);
    agent.reset();
    const fresh = await agent.decide({ ...observation(3), controlEpoch: 2 }, autonomous);
    expect(fresh.feedback).toBeNull();
    expect(fresh.decision.controlEpoch).toBe(2);
  });

  it('rejects a missing interpreter and can restart after cancellation', async () => {
    const broken = new CityHalfAgent({ ...GENERALS_DEFAULTS.agent, pythonExecutable: 'missing-generals-python-fixture' });
    agents.push(broken);
    await expect(broken.decide(observation(1), autonomous)).rejects.toThrow(/ENOENT/);
    const agent = create();
    const pending = agent.decide(observation(1), autonomous);
    agent.reset();
    await expect(pending).rejects.toThrow(/stopped/);
    await agent.decide({ ...observation(2), controlEpoch: 2 }, autonomous);
  });
});

describe('Python protocol failures', () => {
  it('terminates an unresponsive subprocess on timeout', async () => {
    const channel = new PythonChannel(GENERALS_DEFAULTS.agent.pythonExecutable,
      fileURLToPath(new URL('../fixtures/python-channel.py', import.meta.url)), 150);
    try { await expect(channel.request({ kind: 'delay' })).rejects.toThrow(/timed out/); }
    finally { await channel.close(); }
  });
  it('rejects malformed output instead of accepting a move', async () => {
    const channel = new PythonChannel(GENERALS_DEFAULTS.agent.pythonExecutable,
      fileURLToPath(new URL('../fixtures/python-channel.py', import.meta.url)), 3000);
    try { await expect(channel.request({ kind: 'malformed' })).rejects.toThrow(); }
    finally { await channel.close(); }
  });
});
