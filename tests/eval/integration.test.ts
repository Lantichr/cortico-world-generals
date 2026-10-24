import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { StrategyBrief } from '../../src/agent/report.ts';
import { parseConfig } from '../../scripts/llm-suite/config.ts';
import { suitePrompt } from '../../scripts/llm-suite/prompt.ts';
import { createHttpModel } from '../../scripts/llm-suite/provider.ts';
import { runCase } from '../../scripts/llm-suite/runner.ts';
import { snapshotScenarios } from '../../scripts/llm-suite/scenarios.ts';

type Protocol = 'chat_completions' | 'responses';
type WireItem = { role?: string; type?: string; content?: string; call_id?: string; tool_call_id?: string; output?: string };
const tokens = { input: 11, output: 7 };

function send(response: ServerResponse, protocol: Protocol, call?: { id: string; name: string; args: unknown }): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(protocol === 'responses' ? {
    status: 'completed', output: call
      ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续集结。' }] }],
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  } : {
    choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: '继续集结。' } }],
    usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output },
  }));
}

describe('standalone HTTP-to-S1 integration', () => {
  it.each<Protocol>(['chat_completions', 'responses'])('executes a masked-map query and an intent across %s tool rounds', async (protocol) => {
    const requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
    const errors: unknown[] = [];
    const secret = 'fixture-integration-key', hiddenArmies = 543210;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        requests.push({ path: request.url!, authorization: request.headers.authorization, body });
        const items = body[protocol === 'responses' ? 'input' : 'messages'] as WireItem[];
        const brief = JSON.parse(items.find((item) => item.role === 'user')!.content!) as StrategyBrief;
        expect(brief.playerIndex).toBe(0);
        const lastTool = [...items].reverse().find((item) => item.role === 'tool' || item.type === 'function_call_output');
        if (!lastTool) {
          send(response, protocol, { id: 'query-map', name: 'generals_observe', args: { format: 'compact' } });
        } else if ((lastTool.tool_call_id ?? lastTool.call_id) === 'query-map') {
          const map = JSON.parse((lastTool.output ?? lastTool.content)!) as { format: string; grid: string; turn: number };
          expect(map.format).toBe('compact');
          expect(map.grid).toContain('?');
          const target = brief.facts.ownForces[0];
          send(response, protocol, { id: 'choose-goal', name: 'generals_set_intent', args: {
            gameId: brief.gameId, controlEpoch: brief.controlEpoch, revision: brief.intent.lastRevision + 1,
            basedOnTurn: map.turn, expiresTurn: map.turn + 40,
            goal: { kind: 'gather', target: { x: target.x, y: target.y } }, constraints: {},
          } });
        } else {
          expect(lastTool.tool_call_id ?? lastTool.call_id).toBe('choose-goal');
          const accepted = JSON.parse((lastTool.output ?? lastTool.content)!) as StrategyBrief;
          expect(accepted.intent.active?.goal.kind).toBe('gather');
          expect(accepted.intent.lastRevision).toBe(1);
          send(response, protocol);
        }
      } catch (error) {
        errors.push(error);
        response.statusCode = 500;
        response.end('Invalid fixture request.');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const scenario = { ...snapshotScenarios()[0], create() {
        const setup = snapshotScenarios()[0].create();
        // The public total includes another garrison, so this exact hidden count is not a public score.
        Object.assign(setup.arena.cells[97], { owner: 2, armies: hiddenArmies });
        return setup;
      } };
      const config = parseConfig({ mode: 'scripted', tickMs: 0, snapshotTurns: 2,
        maxModelCalls: 3, maxToolRounds: 3, maxToolCalls: 2, maxSearchNodes: 300, decisionBudgetMs: 100 });
      const events: Array<Record<string, any>> = [];
      const result = await runCase({ scenario, kind: 'snapshot', variant: 'llm', repetition: 1,
        gameId: `integration-${protocol}`, config, prompt: suitePrompt(),
        model: createHttpModel({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          protocol, model: 'fixture-strategist', apiKey: secret, maxOutputTokens: 400 }),
        log: (event) => events.push(structuredClone(event)),
      });
      expect(errors).toEqual([]);
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.path === `/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`
        && request.authorization === `Bearer ${secret}`)).toBe(true);
      expect(result.modelCalls).toBe(3);
      expect(result.modelErrors).toBe(0);
      expect(result.acceptedIntents).toBe(1);
      expect(result.rejectedIntents).toBe(0);
      expect(result.inputTokens).toBe(requests.length * tokens.input);
      expect(result.outputTokens).toBe(requests.length * tokens.output);
      expect(result.elapsedTurns).toBe(config.snapshotTurns);
      expect(result.invalidMoves).toBe(0);
      expect(result.s1Moves).toBeGreaterThan(0);
      const actions = events.filter((event) => event.kind === 'arena_applied');
      expect(actions).toHaveLength(config.snapshotTurns);
      expect(actions.every((event) => event.decision.reason !== 'duplicate_or_older_observation'
        && event.decision.observedTurn === event.actionTurn)).toBe(true);
      expect(actions[0].decision.reason).toContain('strategy_goal:1:gather');
      expect(events.filter((event) => event.kind === 'tool').map((event) => event.name))
        .toEqual(['generals_observe', 'generals_set_intent']);
      expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(String(hiddenArmies));
      const log = JSON.stringify(events);
      expect(log).toContain(String(hiddenArmies));
      expect(log).not.toContain(secret);
      expect(log).not.toContain('Bearer');
      expect(log).not.toContain('server_processed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
