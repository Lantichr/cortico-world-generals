import { describe, expect, it } from 'vitest';
import { setImmediate as immediate } from 'node:timers/promises';
import { parseConfig } from '../../scripts/llm-suite/config.ts';
import type { Message, ModelClient, Reply } from '../../scripts/llm-suite/provider.ts';
import { runCase } from '../../scripts/llm-suite/runner.ts';
import { gameScenarios, snapshotScenarios } from '../../scripts/llm-suite/scenarios.ts';
import { createScriptedModel } from '../../scripts/llm-suite/scripted.ts';
import { suitePrompt } from '../../scripts/llm-suite/prompt.ts';
import { FfaArena } from '../agent/ffa-arena.ts';

const config = parseConfig({ tickMs: 0, maxTurns: 16, snapshotTurns: 5, reportIntervalTurns: 100,
  minReportTurns: 100, maxModelCalls: 4, maxSearchNodes: 300, decisionBudgetMs: 100 });
const text: Reply = { message: { role: 'assistant', content: '保留当前策略。' }, usage: { inputTokens: 5, outputTokens: 3 } };
const brief = (messages: Message[]) => JSON.parse(messages.find((message) => message.role === 'user')!.content!);
const intentReply = (messages: Message[], extra: Record<string, unknown> = {}): Reply => {
  const report = brief(messages);
  return { ...text, message: { role: 'assistant', tool_calls: [{ id: 'intent', type: 'function', function: {
    name: 'generals_set_intent', arguments: JSON.stringify({ gameId: report.gameId, controlEpoch: report.controlEpoch,
      revision: report.intent.lastRevision + 1, basedOnTurn: report.turn, expiresTurn: report.turn + 80,
      goal: { kind: 'expand' }, constraints: {}, ...extra }),
  } }] } };
};

describe('standalone S1/S2 runner', () => {
  it('runs all six snapshots with scripted S2 and releases the held rally', async () => {
    const results = [];
    for (const scenario of snapshotScenarios()) results.push(await runCase({ scenario, kind: 'snapshot', variant: 'scripted',
      repetition: 1, gameId: scenario.id, config, prompt: suitePrompt(), model: createScriptedModel() }));
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.invalidMoves === 0)).toBe(true);
    const changed = results.find((result) => result.scenario === 'changing-frontier')!;
    expect(changed.lagTurns[0]).toBe(1);
    const held = results.find((result) => result.scenario === 'held-rally')!;
    expect(held.clearedIntents).toBe(1);
    expect(held.finalIntent.active).toBeNull();
  });

  it('rejects a gather proposal when its owned target is captured during the reply', async () => {
    const result = await runCase({ scenario: snapshotScenarios().find((scenario) => scenario.beforeReply)!,
      kind: 'snapshot', variant: 'llm', repetition: 1, gameId: 'ownership', config, prompt: '', model: {
        async complete(messages) {
          return messages.at(-1)?.role === 'tool' ? text : intentReply(messages, { goal: brief(messages).intent.active.goal });
        },
      } });
    expect(result.boundaryRejected).toBe(true);
    expect(result.rejectedIntents).toBe(1);
    expect(result.finalIntent.lastRejection?.reason).toBe('intent_target_must_be_owned');
    expect(result.finalIntent.active).toBeNull();
    expect(result.invalidMoves).toBe(0);
  });

  it('keeps S1 ticking during one in-flight request and applies the original observation anchor', async () => {
    const events: Array<Record<string, any>> = [];
    let resolveReply: ((value: Reply) => void) | undefined;
    let initial: Message[] = [];
    let outstanding = 0, maxOutstanding = 0;
    const model: ModelClient = { async complete(messages) {
      if (messages.at(-1)?.role === 'tool') return text;
      initial = structuredClone(messages);
      outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
      const reply = await new Promise<Reply>((resolve) => { resolveReply = resolve; });
      outstanding--;
      return reply;
    } };
    const result = await runCase({ scenario: gameScenarios()[0], kind: 'game', variant: 'llm', repetition: 1,
      gameId: 'delayed', config, prompt: suitePrompt(), model, log(event) {
        events.push(structuredClone(event));
        if (event.kind === 'arena_applied' && event.turn === 3) resolveReply!(intentReply(initial));
      } });
    expect(maxOutstanding).toBe(1);
    expect(result.acceptedIntents).toBe(1);
    expect(result.s1Moves).toBeGreaterThan(0);
    expect(result.elapsedTurns).toBe(config.maxTurns);
    expect(result.outcome).toBe('unfinished');
    const tool = events.find((event) => event.kind === 'tool')!;
    expect(tool.args.basedOnTurn).toBe(0);
    expect(tool.appliedTurn).toBeGreaterThanOrEqual(3);
    expect(tool.args.gameId).toBe('delayed');
    expect(events.filter((event) => event.kind === 'arena_applied').every((event) => event.decision.reason !== 'duplicate_or_older_observation')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('server_processed');
  });

  it('times out a model that ignores cancellation while S1 completes its turn budget', async () => {
    const result = await runCase({ scenario: gameScenarios()[0], kind: 'game', variant: 'llm', repetition: 1,
      gameId: 'timeout', config: { ...config, maxTurns: 20, tickMs: 1, maxModelCalls: 1, requestTimeoutMs: 5 }, prompt: '',
      model: { complete: () => new Promise<Reply>(() => {}) } });
    expect(result.timeouts).toBe(1);
    expect(result.modelErrors).toBe(1);
    expect(result.elapsedTurns).toBe(20);
    expect(result.s1Moves).toBeGreaterThan(0);
    expect(result.finalIntent.active).toBeNull();
  });

  it('rejects an expired delayed intent instead of rebasing its deadline', async () => {
    let release: ((value: Reply) => void) | undefined, request: Message[] = [];
    const result = await runCase({ scenario: gameScenarios()[0], kind: 'game', variant: 'llm', repetition: 1,
      gameId: 'expired', config, prompt: '', model: { complete(messages) {
        if (messages.at(-1)?.role === 'tool') return Promise.resolve(text);
        request = messages;
        return new Promise((resolve) => { release = resolve; });
      } }, log(event) {
        if (event.kind === 'arena_applied' && event.turn === 3) release!(intentReply(request, { expiresTurn: 2 }));
      } });
    expect(result.rejectedIntents).toBe(1);
    expect(result.acceptedIntents).toBe(0);
    expect(result.finalIntent.lastRejection?.reason).toBe('intent_expired');
    expect(result.finalIntent.active).toBeNull();
  });

  it('cancels a request at the case boundary and ignores its later reply', async () => {
    let release: ((value: Reply) => void) | undefined, request: Message[] = [];
    const events: Record<string, unknown>[] = [];
    const result = await runCase({ scenario: gameScenarios()[0], kind: 'game', variant: 'llm', repetition: 1,
      gameId: 'ended', config: { ...config, maxTurns: 3 }, prompt: '', model: { complete(messages) {
        request = messages; return new Promise((resolve) => { release = resolve; });
      } }, log: (event) => events.push(structuredClone(event)) });
    release!(intentReply(request));
    await immediate();
    expect(result.modelErrors).toBe(0);
    expect(result.acceptedIntents).toBe(0);
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('closes the intent boundary immediately when S1 wins during an in-flight request', async () => {
    let release: ((value: Reply) => void) | undefined, request: Message[] = [];
    const scenario = { id: 'last-capture', description: '', create() {
      const arena = new FfaArena(3, 1, [0, 2]);
      Object.assign(arena.cells[1], { owner: 0, armies: 20 });
      return { arena, player: 0 };
    } };
    const events: Record<string, unknown>[] = [];
    const result = await runCase({ scenario, kind: 'game', variant: 'llm', repetition: 1,
      gameId: 'terminal', config: { ...config, tickMs: 50 }, prompt: '', model: { complete(messages) {
        request = messages; return new Promise((resolve) => { release = resolve; });
      } }, log(event) {
        events.push(structuredClone(event));
        if (event.kind === 'arena_applied') release!(intentReply(request));
      } });
    expect(result.outcome).toBe('win');
    expect(result.elapsedTurns).toBe(1);
    expect(result.acceptedIntents).toBe(0);
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
  });

  it('does not start a model request for an already finished scenario', async () => {
    let calls = 0;
    const scenario = { id: 'already-ended', description: '', create() {
      const arena = new FfaArena(3, 1, [0, 2]);
      arena.alive[1] = false; arena.winner = 0;
      return { arena, player: 0 };
    } };
    const result = await runCase({ scenario, kind: 'game', variant: 'llm', repetition: 1, gameId: 'finished', config,
      prompt: '', model: { async complete() { calls++; return text; } } });
    expect(calls).toBe(0);
    expect(result.outcome).toBe('win');
    expect(result.elapsedTurns).toBe(0);
  });

  it('keeps score deltas anchored to the last delivered brief, not the previous arena tick', async () => {
    const reports: Array<Record<string, any>> = [];
    await runCase({ scenario: gameScenarios()[0], kind: 'game', variant: 'llm', repetition: 1, gameId: 'deltas',
      config: { ...config, maxTurns: 12, maxModelCalls: 3, reportIntervalTurns: 5, minReportTurns: 5 },
      prompt: '', model: { complete: async () => text }, log(event) {
        if (event.kind === 'report') reports.push(structuredClone(event));
      } });
    expect(reports.map((event) => event.turn)).toEqual([0, 5, 10]);
    expect(reports[1].brief.facts.scores[0].delta.sinceTurn).toBe(0);
    expect(reports[2].brief.facts.scores[0].delta.sinceTurn).toBe(5);
  });

  it('bounds model calls and tools even when a model repeats a tool indefinitely', async () => {
    const model: ModelClient = { async complete() { return { ...text, message: { role: 'assistant', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'generals_strategy_brief', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'generals_strategy_brief', arguments: '{}' } },
    ] } }; } };
    let tools = 0;
    const result = await runCase({ scenario: snapshotScenarios()[0], kind: 'snapshot', variant: 'llm', repetition: 1,
      gameId: 'bounds', config: { ...config, maxToolCalls: 3 }, prompt: '', model,
      log: (event) => { if (event.kind === 'tool') tools++; } });
    expect(tools).toBe(3);
    expect(result.modelCalls).toBe(2);
  });

  it('feeds a paused initial intent to the first real S1 decision without consuming its frame', async () => {
    const decisions: Array<Record<string, any>> = [];
    const result = await runCase({ scenario: snapshotScenarios()[0], kind: 'snapshot', variant: 'llm', repetition: 1,
      gameId: 'first-frame', config: { ...config, snapshotTurns: 1 }, prompt: '',
      model: { async complete(messages) { return messages.at(-1)?.role === 'tool' ? text : intentReply(messages); } },
      log: (event) => { if (event.kind === 'arena_applied') decisions.push(structuredClone(event)); } });
    expect(result.acceptedIntents).toBe(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision.reason).toContain('strategy_goal:1:expand');
    expect(decisions[0].decision.reason).not.toContain('duplicate_or_older_observation');
  });
});
