import { setTimeout as delay } from 'node:timers/promises';
import { GeneralsAgent } from '../../src/agent/agent.ts';
import type { AgentDecision, AgentObservation, AgentReport } from '../../src/agent/contracts.ts';
import { createStrategyBrief, significantStrategyChange, type StrategyBrief } from '../../src/agent/report.ts';
import { IntentController } from '../../src/intent.ts';
import type { FfaArena } from '../../tests/agent/ffa-arena.ts';
import type { SuiteConfig } from './config.ts';
import type { Message, ModelClient } from './provider.ts';
import type { Scenario } from './scenarios.ts';
import { createTools } from './tools.ts';

export type SuiteLog = (event: Record<string, unknown>) => void;
export interface CaseResult {
  scenario: string; variant: 's1' | 'scripted' | 'llm'; repetition: number; kind: 'snapshot' | 'game';
  outcome: 'win' | 'loss' | 'unfinished' | 'snapshot'; turn: number; elapsedTurns: number; wallMs: number;
  modelCalls: number; modelErrors: number; timeouts: number; inputTokens: number; outputTokens: number;
  acceptedIntents: number; rejectedIntents: number; clearedIntents: number;
  s1Moves: number; s1Waits: number; invalidMoves: number; contestedMoves: number;
  maxEstimatedHomeGap: number; ownCities: number; ownArmies: number; homeArmies: number | null;
  latencyMs: number[]; lagTurns: number[];
  referenceChoiceMatch: boolean | null; boundaryRejected: boolean;
  finalIntent: ReturnType<IntentController['snapshot']>;
}

class Session {
  readonly intents = new IntentController();
  readonly agent: GeneralsAgent;
  observation!: AgentObservation;
  decision: AgentDecision | null = null;
  private decisionRevision = -1;
  previousDelivered: StrategyBrief | null = null;
  closed = false;
  readonly tools: ReturnType<typeof createTools>;

  constructor(readonly arena: FfaArena, readonly player: number, readonly gameId: string, config: SuiteConfig, scenario: Scenario) {
    this.agent = new GeneralsAgent(config);
    this.observe();
    if (scenario.initialIntent) this.intents.submit(scenario.initialIntent(this.observation), this.observation);
    this.tools = createTools({ observation: () => this.observation, status: () => this.status(),
      brief: () => this.deliver(), intents: this.intents });
  }
  observe(): void {
    this.observation = { ...this.arena.observe(this.player), gameId: this.gameId };
    this.intents.refresh(this.observation);
  }
  decide(): void {
    const state = this.intents.snapshot();
    if (this.observation.revision === this.decisionRevision) return;
    this.decision = this.agent.decide(this.observation, state.active, state.status === 'completed');
    this.intents.feedback(this.agent.getStrategyFeedback());
    this.decisionRevision = this.observation.revision;
  }
  status(): AgentReport {
    const intent = this.intents.snapshot();
    return { gameId: this.gameId, controlEpoch: this.observation.controlEpoch, control: 'autonomous',
      operatorPaused: false, operatorPauseLinked: false, phase: this.closed ? 'ended' : 'playing',
      observedTurn: this.observation.turn, method: 'bounded_rule_search', activeIntentRevision: intent.active?.revision ?? null,
      intent, supportedRules: 'standard_or_city_state_ffa', error: null, lastDecision: this.decision,
      pendingAction: null, lastFeedback: null };
  }
  brief(): StrategyBrief { return createStrategyBrief(this.observation, this.status(), this.previousDelivered ?? undefined); }
  deliver(): StrategyBrief {
    const brief = this.brief();
    this.previousDelivered = brief;
    return brief;
  }
}

async function complete(model: ModelClient, messages: Message[], session: Session, config: SuiteConfig,
  close: AbortSignal): Promise<Awaited<ReturnType<ModelClient['complete']>>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  close.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, config.requestTimeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(close.aborted ? 'case_ended' : 'request_timeout'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([model.complete(messages, session.tools.declarations, controller.signal), aborted]); }
  finally {
    clearTimeout(timer);
    close.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function runCase(options: {
  scenario: Scenario; kind: 'snapshot' | 'game'; variant: CaseResult['variant']; repetition: number;
  gameId: string; config: SuiteConfig; prompt: string; model?: ModelClient; log?: SuiteLog;
}): Promise<CaseResult> {
  const { scenario, config, model, kind, variant } = options;
  const { arena, player } = scenario.create();
  const startedAt = performance.now(), startTurn = arena.turn;
  const session = new Session(arena, player, options.gameId, config, scenario);
  const emit = (event: string, data: Record<string, unknown> = {}) => options.log?.({ kind: event, gameId: options.gameId,
    turn: arena.turn, at: new Date().toISOString(), ...data });
  const result: CaseResult = {
    scenario: scenario.id, variant, repetition: options.repetition, kind, outcome: kind === 'snapshot' ? 'snapshot' : 'unfinished',
    turn: arena.turn, elapsedTurns: 0, wallMs: 0, modelCalls: 0, modelErrors: 0, timeouts: 0, inputTokens: 0, outputTokens: 0,
    acceptedIntents: 0, rejectedIntents: 0, clearedIntents: 0, s1Moves: 0, s1Waits: 0, invalidMoves: 0, contestedMoves: 0,
    maxEstimatedHomeGap: 0, ownCities: 0, ownArmies: 0, homeArmies: null, latencyMs: [], lagTurns: [],
    referenceChoiceMatch: null, boundaryRejected: false, finalIntent: session.intents.snapshot(),
  };
  const successfulGoals: string[] = [];
  let pending: Promise<void> | null = null, lastReportTurn = -Infinity, beforeReplyDone = false;
  const close = new AbortController();
  const externalStep = () => {
    if (beforeReplyDone || !scenario.beforeReply) return;
    beforeReplyDone = true;
    scenario.beforeReply(arena, player);
    session.observe();
    emit('external_step', { observation: session.observation });
    if (!arena.alive[player] || arena.winner !== null) { session.closed = true; close.abort(); }
  };
  const cycle = async () => {
    const brief = session.deliver();
    lastReportTurn = arena.turn;
    const messages: Message[] = [{ role: 'system', content: options.prompt }, { role: 'user', content: JSON.stringify(brief) }];
    emit('report', { brief });
    let toolCalls = 0;
    for (let round = 0; round < config.maxToolRounds && result.modelCalls < config.maxModelCalls && !session.closed; round++) {
      if (JSON.stringify(messages).length > config.maxContextChars) { emit('cycle_limit', { reason: 'context_chars' }); return; }
      const observedTurn = arena.turn, callStartedAt = performance.now();
      result.modelCalls++;
      const call = result.modelCalls;
      emit('model_request', { call, observedTurn, messages });
      let reply: Awaited<ReturnType<ModelClient['complete']>>;
      try { reply = await complete(model!, messages, session, config, close.signal); }
      catch (error) {
        const reason = error instanceof Error && error.message === 'request_timeout' ? 'request_timeout'
          : close.signal.aborted ? 'case_ended' : 'model_request_failed';
        if (reason !== 'case_ended') { result.modelErrors++; if (reason === 'request_timeout') result.timeouts++; }
        const message = error instanceof Error ? error.message : '';
        const detail = ['Model request aborted.', 'Model request failed.', 'Invalid model response.', 'Incomplete model response.'].includes(message)
          || /^Model request failed \(HTTP [1-5]\d\d\)\.$/.test(message) ? message : undefined;
        emit('model_error', { call, observedTurn, reason, detail, latencyMs: performance.now() - callStartedAt });
        return;
      }
      const latencyMs = performance.now() - callStartedAt;
      result.latencyMs.push(latencyMs);
      result.inputTokens += reply.usage.inputTokens; result.outputTokens += reply.usage.outputTokens;
      emit('model_reply', { call, observedTurn, receivedTurn: arena.turn, latencyMs, reply });
      if (session.closed) return;
      if (kind === 'snapshot') externalStep();
      result.lagTurns.push(arena.turn - observedTurn);
      if (session.closed) return;
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      if (!calls.length) return;
      for (const call of calls) {
        if (++toolCalls > config.maxToolCalls) { emit('cycle_limit', { reason: 'tool_calls' }); return; }
        let output: unknown;
        let args: Record<string, unknown> | null = null;
        try {
          const value = JSON.parse(call.function.arguments);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
          args = value;
          output = session.tools.execute(call.function.name, args!);
        } catch { output = { ok: false, error: 'invalid_tool_arguments' }; }
        const failed = !!output && typeof output === 'object' && (output as { ok?: boolean }).ok === false;
        if (call.function.name === 'generals_set_intent' || call.function.name === 'generals_clear_intent') {
          if (failed) {
            result.rejectedIntents++;
            if (String((output as { error?: string }).error).includes('intent_target_must_be_owned')) result.boundaryRejected = true;
          } else if (call.function.name === 'generals_clear_intent') result.clearedIntents++;
          else {
            result.acceptedIntents++;
            const goal = session.intents.snapshot().active?.goal.kind;
            if (goal) successfulGoals.push(goal);
          }
        }
        emit('tool', { callId: call.id, name: call.function.name, args, output, observedTurn, appliedTurn: arena.turn });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    emit('cycle_limit', { reason: result.modelCalls >= config.maxModelCalls ? 'model_calls' : 'tool_rounds' });
  };
  emit('case_start', { scenario: scenario.id, variant, repetition: options.repetition, caseKind: kind,
    player, width: arena.width, height: arena.height, cells: arena.cells, generals: arena.generals,
    initialIntent: session.intents.snapshot(), observation: session.observation, tools: session.tools.declarations });
  const startCycle = () => {
    pending = cycle().finally(() => { pending = null; });
    return pending;
  };
  const playable = arena.alive[player] && arena.winner === null;
  if (model && playable) {
    if (kind === 'snapshot' || config.timing === 'paused') await startCycle();
    else startCycle();
  } else if (kind === 'snapshot' && playable) externalStep();

  const rolloutStartTurn = arena.turn;
  const limit = kind === 'snapshot' ? config.snapshotTurns : config.maxTurns;
  while (arena.turn - rolloutStartTurn < limit && arena.alive[player] && arena.winner === null) {
    const tickStartedAt = performance.now();
    if (kind === 'game' && model && !pending && result.modelCalls < config.maxModelCalls) {
      const elapsed = arena.turn - lastReportTurn;
      if (elapsed >= config.reportIntervalTurns || elapsed >= config.minReportTurns
        && significantStrategyChange(session.previousDelivered, session.brief())) {
        if (config.timing === 'paused') await startCycle(); else startCycle();
      }
    }
    // A newly accepted intent is consumed before the next local action.
    session.decide();
    const decision = session.decision!;
    if (decision.kind === 'move') result.s1Moves++; else result.s1Waits++;
    result.maxEstimatedHomeGap = Math.max(result.maxEstimatedHomeGap, session.brief().estimates?.homeDefense?.gapArmies ?? 0);
    const moves = arena.alive.map((alive, opponent) => !alive ? null : opponent === player
      ? decision.kind === 'move' ? decision.move : null : arena.baseline(opponent, 'pusher'));
    const actionTurn = arena.turn;
    arena.step(moves);
    session.observe();
    emit('arena_applied', { actionTurn, decision, moves, observation: session.observation,
      cells: arena.cells, alive: arena.alive, generals: arena.generals });
    if (!arena.alive[player] || arena.winner !== null || arena.turn - rolloutStartTurn >= limit) {
      session.closed = true; close.abort(); break;
    }
    if (kind === 'game') {
      if (model && config.timing === 'realtime' && config.tickMs > 0) await delay(Math.max(0, config.tickMs - (performance.now() - tickStartedAt)));
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  session.closed = true; close.abort();
  if (pending) await pending;
  result.turn = arena.turn; result.elapsedTurns = arena.turn - startTurn; result.wallMs = performance.now() - startedAt;
  if (kind === 'game') result.outcome = arena.winner === player ? 'win' : !arena.alive[player] ? 'loss' : 'unfinished';
  result.invalidMoves = arena.invalidMoves[player]; result.contestedMoves = arena.contestedMoves[player];
  result.ownCities = arena.cells.filter((cell) => cell.owner === player && cell.city).length;
  result.ownArmies = arena.cells.filter((cell) => cell.owner === player).reduce((sum, cell) => sum + cell.armies, 0);
  result.homeArmies = arena.generals[player] < 0 ? null : arena.cells[arena.generals[player]].armies;
  result.finalIntent = session.intents.snapshot();
  if (model && scenario.expected) result.referenceChoiceMatch = scenario.expected === 'reject' ? result.boundaryRejected
    : scenario.expected === 'clear_intent' ? result.clearedIntents > 0
      || successfulGoals.some((goal) => goal !== 'gather') && !(result.finalIntent.active?.constraints.reserves?.length)
      : successfulGoals.includes(scenario.expected);
  emit('case_end', { result });
  return result;
}
