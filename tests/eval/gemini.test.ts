import { describe, expect, it } from 'vitest';
import { geminiRequest, parseGeminiReply } from '../../scripts/llm-suite/gemini.ts';
import type { Message, Tool } from '../../scripts/llm-suite/provider.ts';

const options = { model: 'fixture-strategist', maxOutputTokens: 400 };
const tools: Tool[] = [{ type: 'function', function: { name: 'generals_agent_status', description: 'Read current intent.',
  parameters: { type: 'object', properties: {} } } }];
const call = { type: 'function_call', id: 'call-1', name: 'generals_agent_status', arguments: {} };
const text = { type: 'model_output', content: [{ type: 'text', text: 'Keep gathering.' }] };

describe('native Interactions serialization', () => {
  it('sends system instructions, user steps, tools and bounded generation configuration', () => {
    const request = geminiRequest([{ role: 'system', content: 'Choose an intent.' }, { role: 'user', content: 'turn=50' }],
      tools, { ...options, reasoningEffort: 'low' });
    expect(request).toEqual({
      model: options.model, stream: false, store: false, system_instruction: 'Choose an intent.',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'turn=50' }] }],
      tools: [{ type: 'function', ...tools[0].function }],
      generation_config: { max_output_tokens: options.maxOutputTokens, thinking_level: 'low', tool_choice: 'auto' },
    });
    expect(request).not.toHaveProperty('previous_interaction_id');
  });

  it('omits optional thinking, tools and instructions in a text-only request', () => {
    expect(geminiRequest([{ role: 'user', content: 'Observe.' }], [], options)).toEqual({
      model: options.model, stream: false, store: false,
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'Observe.' }] }],
      generation_config: { max_output_tokens: options.maxOutputTokens },
    });
  });

  it('replays thought signatures and tool call ids unchanged through successive tool rounds', () => {
    const steps = [{ type: 'thought', signature: 'fixture-thought-signature', summary: [{ type: 'text', text: 'Inspect the current intent.' }] }, call];
    const reply = parseGeminiReply({ status: 'requires_action', steps });
    const messages: Message[] = [{ role: 'system', content: 'Choose an intent.' }, { role: 'user', content: 'turn=50' },
      reply.message, { role: 'tool', tool_call_id: 'call-1', content: '{"status":"active"}' }];
    expect(geminiRequest(messages, tools, options).input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'turn=50' }] }, ...steps,
      { type: 'function_result', call_id: 'call-1', result: '{"status":"active"}' },
    ]);
    expect(reply.message.geminiOutput).toBe(steps);
  });

  it('serializes canonical assistant tool calls when no native steps are present', () => {
    expect(geminiRequest([{ role: 'assistant', content: 'Inspect the intent.', tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: '{ "player": 2 }' } }] }], [], options).input).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: 'Inspect the intent.' }] }, { ...call, arguments: { player: 2 } },
    ]);
  });

  it('does not invent an empty assistant text step before a canonical tool call', () => {
    expect(geminiRequest([{ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: '{}' } }] }], [], options).input).toEqual([call]);
  });

  it.each(['{ private diagnostic', 'null', '[]', '"text"'])('rejects non-object canonical function arguments without exposing them: %#', (argumentsText) => {
    expect(() => geminiRequest([{ role: 'assistant', tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: argumentsText } }] }], [], options)).toThrow(/^Invalid model request\.$/);
  });
});

describe('native Interactions responses', () => {
  it('converts object arguments to canonical tool calls and counts text plus thought tokens', () => {
    const steps = [{ type: 'thought', signature: 'fixture-signature' }, { ...call, arguments: { player: 2 } }];
    expect(parseGeminiReply({ status: 'requires_action', steps,
      usage: { total_input_tokens: 13, total_output_tokens: 7, total_thought_tokens: 11, total_tokens: 31 } })).toEqual({
      message: { role: 'assistant', content: null, geminiOutput: steps,
        tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: '{"player":2}' } }] },
      usage: { inputTokens: 13, outputTokens: 18 },
    });
  });

  it('joins text output without treating a thought summary as assistant speech', () => {
    const steps = [{ type: 'thought', signature: 'fixture-signature', summary: [{ type: 'text', text: 'Private summary.' }] },
      text, { type: 'model_output', content: [{ type: 'text', text: 'Then attack.' }] }];
    expect(parseGeminiReply({ status: 'completed', steps })).toEqual({
      message: { role: 'assistant', content: 'Keep gathering.\nThen attack.', geminiOutput: steps },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('accepts an empty completed output with no reported usage', () => {
    expect(parseGeminiReply({ status: 'completed', steps: [{ type: 'model_output' }] }).message.content).toBeNull();
  });

  it.each(['incomplete', 'in_progress', 'queued', null, undefined])('rejects non-final status %s before exposing tools', (status) => {
    expect(() => parseGeminiReply({ status, steps: [call] })).toThrow(/^Incomplete model response\.$/);
  });

  it.each([
    null, {}, { status: 'completed', output: [text] }, { status: 'failed', steps: [call] },
    { status: 'cancelled', steps: [call] }, { status: 'completed', steps: [text], error: { message: 'Private diagnostic.' } },
    { status: 'requires_action', steps: [text] }, { status: 'completed', steps: null },
    { status: 'completed', steps: [null] }, { status: 'completed', steps: [{ type: 'unexpected_tool' }] },
    { status: 'completed', steps: [{ type: 'thought', signature: null }] },
    { status: 'completed', steps: [{ type: 'thought', summary: 'text' }] },
    { status: 'completed', steps: [{ type: 'model_output', content: null }] },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: null }] }] },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: 'private' }] }] },
    { status: 'requires_action', steps: [{ ...call, id: '' }] },
    { status: 'requires_action', steps: [{ ...call, name: '' }] },
    { status: 'requires_action', steps: [{ ...call, arguments: '{}' }] },
    { status: 'requires_action', steps: [{ ...call, arguments: [] }] },
    { status: 'requires_action', steps: [call, call] },
    { status: 'completed', steps: [text], usage: null },
    { status: 'completed', steps: [text], usage: { total_input_tokens: null } },
    { status: 'completed', steps: [text], usage: { total_input_tokens: -1 } },
    { status: 'completed', steps: [text], usage: { total_output_tokens: 0.5 } },
    { status: 'completed', steps: [text], usage: { total_thought_tokens: '11' } },
    { status: 'completed', steps: [text], usage: { total_output_tokens: Number.MAX_SAFE_INTEGER, total_thought_tokens: 1 } },
  ])('rejects malformed native envelopes without exposing response content: %#', (value) => {
    expect(() => parseGeminiReply(value)).toThrow(/^Invalid model response\.$/);
  });
});
