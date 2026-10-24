import type { Message, Reply, Tool } from './provider.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function functionArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('Invalid model request.'); }
  if (!record(parsed)) throw new Error('Invalid model request.');
  return parsed;
}

/** Interactions is stateless here; model steps include signatures needed by subsequent tool rounds. */
export function geminiRequest(messages: Message[], tools: Tool[], options: {
  model: string; maxOutputTokens: number; reasoningEffort?: string;
}): Record<string, unknown> {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n\n');
  const input = messages.flatMap((message): unknown[] => {
    if (message.role === 'system') return [];
    if (message.role === 'assistant' && message.geminiOutput) return message.geminiOutput;
    if (message.role === 'tool') return [{ type: 'function_result', call_id: message.tool_call_id, result: message.content ?? '' }];
    const steps: unknown[] = [];
    if (message.content != null || !message.tool_calls?.length) steps.push({
      type: message.role === 'assistant' ? 'model_output' : 'user_input',
      content: [{ type: 'text', text: message.content ?? '' }],
    });
    for (const call of message.tool_calls ?? []) steps.push({
      type: 'function_call', id: call.id, name: call.function.name, arguments: functionArguments(call.function.arguments),
    });
    return steps;
  });
  return {
    model: options.model, input, stream: false, store: false,
    ...(system ? { system_instruction: system } : {}),
    generation_config: {
      max_output_tokens: options.maxOutputTokens,
      ...(options.reasoningEffort !== undefined ? { thinking_level: options.reasoningEffort } : {}),
      ...(tools.length ? { tool_choice: 'auto' } : {}),
    },
    ...(tools.length ? { tools: tools.map((tool) => ({ type: tool.type, ...tool.function })) } : {}),
  };
}

function usage(value: unknown): Reply['usage'] {
  if (value === undefined) return { inputTokens: 0, outputTokens: 0 };
  if (!record(value)) throw new Error('Invalid model response.');
  const count = (key: string): number => {
    const tokens = value[key] === undefined ? 0 : value[key];
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid model response.');
    return tokens;
  };
  // Interactions reports generated text and thought tokens separately.
  const outputTokens = count('total_output_tokens') + count('total_thought_tokens');
  if (!Number.isSafeInteger(outputTokens)) throw new Error('Invalid model response.');
  return { inputTokens: count('total_input_tokens'), outputTokens };
}

export function parseGeminiReply(value: unknown): Reply {
  const invalid = () => new Error('Invalid model response.');
  if (!record(value) || !Array.isArray(value.steps) || value.error != null || value.status === 'failed' || value.status === 'cancelled') {
    throw invalid();
  }
  if (value.status !== 'completed' && value.status !== 'requires_action') throw new Error('Incomplete model response.');
  const text: string[] = [];
  const calls: NonNullable<Message['tool_calls']> = [];
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (!record(step)) throw invalid();
    if (step.type === 'thought') {
      if (step.signature !== undefined && typeof step.signature !== 'string'
        || step.summary !== undefined && !Array.isArray(step.summary)) throw invalid();
    } else if (step.type === 'model_output') {
      if (step.content === undefined) continue;
      if (!Array.isArray(step.content)) throw invalid();
      for (const part of step.content) {
        if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') throw invalid();
        text.push(part.text);
      }
    } else if (step.type === 'function_call') {
      if (typeof step.id !== 'string' || !step.id.trim() || ids.has(step.id)
        || typeof step.name !== 'string' || !step.name.trim() || !record(step.arguments)) throw invalid();
      ids.add(step.id);
      calls.push({ id: step.id, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } });
    } else throw invalid();
  }
  if (value.status === 'requires_action' && !calls.length) throw invalid();
  return {
    message: { role: 'assistant', content: text.length ? text.join('\n') : null, geminiOutput: value.steps,
      ...(calls.length ? { tool_calls: calls } : {}) },
    usage: usage(value.usage),
  };
}
