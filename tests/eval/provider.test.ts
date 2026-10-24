import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHttpModel, type Message, type Tool } from '../../scripts/llm-suite/provider.ts';

type Received = { path: string; authorization: string | undefined; body: Record<string, unknown> };
const servers: Server[] = [];

async function serve(handler: (request: Received, response: ServerResponse) => void) {
  const requests: Received[] = [];
  let received!: (request: Received) => void;
  const firstRequest = new Promise<Received>((resolve) => { received = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = { path: request.url!, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> };
    requests.push(entry);
    received(entry);
    handler(entry, response);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, firstRequest };
}

function send(response: ServerResponse, body: unknown) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

const textReply = { choices: [{ message: { role: 'assistant', content: 'Keep the current intent.' } }],
  usage: { prompt_tokens: 13, completion_tokens: 7 } };
const model = (baseUrl: string) => createHttpModel({ baseUrl, model: 'fixture-strategist', apiKey: 'fixture-private-key', maxOutputTokens: 400 });
const complete = (baseUrl: string, signal = new AbortController().signal) => model(baseUrl).complete([], [], signal);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => err ? reject(err) : resolve());
  })));
});

describe('standalone model HTTP adapter', () => {
  it('transmits the conversation and tool schemas and preserves raw tool arguments', async () => {
    const rawArguments = '{ "player": ';
    const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'generals_set_intent', arguments: rawArguments } };
    const server = await serve((_, response) => send(response, {
      ...textReply, choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] } }],
    }));
    const messages: Message[] = [{ role: 'system', content: 'Choose an intent.' }, { role: 'user', content: 'turn=50' },
      { role: 'assistant', content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"accepted":false}' }];
    const tools: Tool[] = [{ type: 'function', function: { name: 'generals_set_intent', description: 'Submit an intent.',
      parameters: { type: 'object', properties: { player: { type: 'integer' } }, required: ['player'] } } }];
    const reply = await model(`${server.baseUrl}/`).complete(messages, tools, new AbortController().signal);
    expect(reply).toEqual({ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, usage: { inputTokens: 13, outputTokens: 7 } });
    expect(server.requests).toEqual([{ path: '/v1/chat/completions', authorization: 'Bearer fixture-private-key', body: {
      model: 'fixture-strategist', messages, stream: false, max_tokens: 400, tools, tool_choice: 'auto', parallel_tool_calls: false,
    } }]);
  });

  it('allows text-only completions without tools, credentials, or reported usage', async () => {
    const server = await serve((_, response) => send(response, { choices: textReply.choices }));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100 });
    expect(await client.complete([{ role: 'user', content: 'Observe.' }], [], new AbortController().signal)).toEqual({
      message: textReply.choices[0].message, usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(server.requests[0].authorization).toBeUndefined();
    expect(server.requests[0].body).not.toHaveProperty('tools');
    expect(server.requests[0].body).not.toHaveProperty('tool_choice');
  });

  it.each(['length', 'content_filter'])('rejects a Chat %s completion before exposing any function calls', async (finish_reason) => {
    const server = await serve((_, response) => send(response, { choices: [{ finish_reason,
      message: { role: 'assistant', content: 'private diagnostic', tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: 'generals_clear_intent', arguments: '{}' } }] } }], usage: textReply.usage }));
    await expect(complete(server.baseUrl)).rejects.toThrow(/^Incomplete model response\.$/);
    expect(server.requests).toHaveLength(1);
  });

  it.each(['stop', 'tool_calls'])('accepts a completed Chat response with finish reason %s', async (finish_reason) => {
    const message = finish_reason === 'stop' ? textReply.choices[0].message : { role: 'assistant', content: null, tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'generals_agent_status', arguments: '{}' } },
    ] };
    const server = await serve((_, response) => send(response, { ...textReply,
      choices: [{ message, finish_reason }] }));
    expect((await complete(server.baseUrl)).message).toEqual(message);
    expect(server.requests).toHaveLength(1);
  });

  it('converts a Responses conversation and function results while preserving protocol output', async () => {
    const rawArguments = '{ "player": ';
    const output = [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Keep gathering.' }] },
      { type: 'function_call', id: 'item-id', call_id: 'call-2', name: 'generals_set_intent', arguments: rawArguments },
    ];
    const server = await serve((_, response) => send(response, { status: 'completed', output, usage: { input_tokens: 19, output_tokens: 12 } }));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100, protocol: 'responses' });
    const parameters = { type: 'object', properties: { player: { type: 'integer' } } };
    const reply = await client.complete([
      { role: 'system', content: 'Choose an intent.' }, { role: 'user', content: 'turn=50' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'observe', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"turn":51}' },
    ], [{ type: 'function', function: { name: 'generals_set_intent', description: 'Submit an intent.', parameters } }], new AbortController().signal);
    expect(reply).toEqual({ message: { role: 'assistant', content: 'Keep gathering.', protocolOutput: output, tool_calls: [
      { id: 'call-2', type: 'function', function: { name: 'generals_set_intent', arguments: rawArguments } },
    ] }, usage: { inputTokens: 19, outputTokens: 12 } });
    expect(server.requests[0]).toEqual({ path: '/v1/responses', authorization: undefined, body: {
      model: 'fixture-strategist', stream: false, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 100, tool_choice: 'auto', parallel_tool_calls: false,
      input: [{ role: 'system', content: 'Choose an intent.' }, { role: 'user', content: 'turn=50' },
        { type: 'function_call', call_id: 'call-1', name: 'observe', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: '{"turn":51}' }],
      tools: [{ type: 'function', name: 'generals_set_intent', description: 'Submit an intent.', parameters, strict: false }],
    } });
  });

  it('returns a Responses refusal as text with zero usage when none is reported', async () => {
    const output = [
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No intent submitted.' }] },
    ];
    const server = await serve((_, response) => send(response, { output }));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100, protocol: 'responses' });
    expect(await client.complete([], [], new AbortController().signal)).toEqual({
      message: { role: 'assistant', content: 'No intent submitted.', protocolOutput: output }, usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(server.requests[0].body).not.toHaveProperty('tools');
  });

  it.each(['incomplete', 'in_progress', 'queued', null])('rejects a non-completed Responses status %s before exposing function calls', async (status) => {
    const server = await serve((_, response) => send(response, { status,
      incomplete_details: { reason: 'private diagnostic' },
      output: [{ type: 'function_call', call_id: 'call-1', name: 'generals_clear_intent', arguments: '{}' }] }));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100, protocol: 'responses' });
    await expect(client.complete([], [], new AbortController().signal)).rejects.toThrow(/^Incomplete model response\.$/);
    expect(server.requests).toHaveLength(1);
  });

  it('passes reasoning and function-call output through consecutive Responses tool rounds', async () => {
    const output = [{ id: 'reasoning-1', type: 'reasoning', summary: [], encrypted_content: 'fixture-encrypted-reasoning' },
      { id: 'item-1', type: 'function_call', call_id: 'call-1', name: 'observe', arguments: '{}' }];
    const server = await serve((_, response) => send(response, { output }));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100, protocol: 'responses' });
    const messages: Message[] = [{ role: 'user', content: 'turn=50' }];
    const first = await client.complete(messages, [], new AbortController().signal);
    messages.push(first.message, { role: 'tool', tool_call_id: 'call-1', content: '{"turn":51}' });
    await client.complete(messages, [], new AbortController().signal);
    expect(server.requests[1].body.input).toEqual([{ role: 'user', content: 'turn=50' }, ...output,
      { type: 'function_call_output', call_id: 'call-1', output: '{"turn":51}' }]);
  });

  it.each([
    { output: null },
    { output: [], status: 'failed', error: { message: 'private diagnostic' } },
    { output: [{ type: 'message', role: 'user', content: [] }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: null }] }] },
    { output: [{ type: 'function_call', call_id: 'call-1', name: 'observe', arguments: {} }] },
    { output: [{ type: 'unexpected_tool' }] },
    { output: [], usage: { input_tokens: -1, output_tokens: 2 } },
  ])('validates the Responses envelope and tool-call fields %#', async (body) => {
    const server = await serve((_, response) => send(response, body));
    const client = createHttpModel({ baseUrl: server.baseUrl, model: 'fixture-strategist', maxOutputTokens: 100, protocol: 'responses' });
    await expect(client.complete([], [], new AbortController().signal)).rejects.toThrow('Invalid model response.');
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    'not a URL', 'http://example.invalid/v1', 'ftp://localhost/v1', 'https://name:secret@example.invalid/v1',
    'https://@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/v1?',
    'https://example.invalid/v1#secret', 'https://example.invalid/v1#',
  ])('rejects an unsafe or credential-bearing endpoint %s', (baseUrl) => {
    expect(() => model(baseUrl)).toThrow('Invalid model endpoint URL.');
  });

  it.each(['https://example.invalid/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1', 'http://127.1.2.3:1234/v1'])('accepts HTTPS or loopback HTTP configuration %s', (baseUrl) => {
    expect(() => model(baseUrl)).not.toThrow();
  });

  it('rejects empty model names and invalid output budgets before a request', () => {
    expect(() => createHttpModel({ baseUrl: 'https://example.invalid', model: ' ', maxOutputTokens: 1 })).toThrow('Invalid model request configuration.');
    expect(() => createHttpModel({ baseUrl: 'https://example.invalid', model: 'fixture', maxOutputTokens: 0 })).toThrow('Invalid model request configuration.');
  });

  const call = { id: 'call-1', type: 'function', function: { name: 'observe', arguments: '{}' } };
  it.each([
    null,
    {},
    { choices: [] },
    { choices: [{ message: { role: 'user', content: 'wrong role' } }] },
    { choices: [{ message: { role: 'assistant', content: [] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: {} } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [null] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ ...call, id: '' }] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [call, call] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ ...call, type: 'other' }] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ ...call, function: { name: 'observe', arguments: {} } }] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ ...call, function: { name: '', arguments: '{}' } }] } }] },
    { ...textReply, usage: null },
    { ...textReply, usage: { prompt_tokens: -1, completion_tokens: 7 } },
    { ...textReply, usage: { prompt_tokens: 13, completion_tokens: 0.5 } },
  ])('rejects malformed response envelopes without exposing their content %#', async (reply) => {
    const server = await serve((_, response) => send(response, reply));
    await expect(complete(server.baseUrl)).rejects.toThrow('Invalid model response.');
    expect(server.requests).toHaveLength(1);
  });

  it('redacts non-JSON responses and HTTP failures without retrying', async () => {
    for (const status of [200, 401]) {
      const server = await serve((_, response) => {
        response.statusCode = status;
        response.end('fixture-private-key and a private diagnostic');
      });
      const error = await complete(server.baseUrl).catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(status === 200 ? 'Invalid model response.' : 'Model request failed (HTTP 401).');
      expect(server.requests).toHaveLength(1);
    }
  });

  it('does not follow redirects to another endpoint', async () => {
    const destination = await serve((_, response) => send(response, textReply));
    const server = await serve((_, response) => {
      response.writeHead(307, { Location: `${destination.baseUrl}/chat/completions` });
      response.end();
    });
    await expect(complete(server.baseUrl)).rejects.toThrow('Model request failed.');
    expect(server.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
  });

  it('aborts an in-flight request through the supplied signal', async () => {
    const server = await serve(() => {});
    const controller = new AbortController();
    const promise = complete(server.baseUrl, controller.signal);
    await server.firstRequest;
    controller.abort();
    await expect(promise).rejects.toThrow('Model request aborted.');
    expect(server.requests).toHaveLength(1);
  });
});
