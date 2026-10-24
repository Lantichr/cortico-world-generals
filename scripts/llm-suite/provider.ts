export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** Responses output items are replayed verbatim to retain reasoning and function-call state. */
  protocolOutput?: unknown[];
};

export type Tool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type Reply = {
  message: Message;
  usage: { inputTokens: number; outputTokens: number };
};

export interface ModelClient {
  complete(messages: Message[], tools: Tool[], signal: AbortSignal): Promise<Reply>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpoint(baseUrl: string, protocol: 'chat_completions' | 'responses'): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid model endpoint URL.'); }
  const authority = baseUrl.trim().replaceAll('\\', '/').match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || authority?.includes('@') || baseUrl.includes('?') || baseUrl.includes('#')
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Invalid model endpoint URL.');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  return url.href;
}

function parseUsage(value: unknown, keys: ['prompt_tokens', 'completion_tokens'] | ['input_tokens', 'output_tokens']): Reply['usage'] {
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (value !== undefined) {
    if (!record(value)) throw new Error('Invalid model response.');
    for (const [index, targetKey] of (['inputTokens', 'outputTokens'] as const).entries()) {
      const count = value[keys[index]];
      if (count !== undefined) {
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid model response.');
        usage[targetKey] = count;
      }
    }
  }
  return usage;
}

function parseChatReply(value: unknown): Reply {
  const invalid = () => new Error('Invalid model response.');
  if (!record(value) || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)) {
    throw invalid();
  }
  const source = value.choices[0].message;
  if (value.choices[0].finish_reason === 'length' || value.choices[0].finish_reason === 'content_filter') throw new Error('Incomplete model response.');
  if (source.role !== 'assistant' || (source.content !== undefined && source.content !== null && typeof source.content !== 'string')) {
    throw invalid();
  }
  const message: Message = { role: 'assistant' };
  if (source.content !== undefined) message.content = source.content as string | null;
  if (source.tool_calls !== undefined) {
    if (!Array.isArray(source.tool_calls)) throw invalid();
    const ids = new Set<string>();
    message.tool_calls = source.tool_calls.map((call: unknown) => {
      if (!record(call) || typeof call.id !== 'string' || !call.id.trim() || ids.has(call.id) || call.type !== 'function'
        || !record(call.function) || typeof call.function.name !== 'string' || !call.function.name.trim()
        || typeof call.function.arguments !== 'string') throw invalid();
      ids.add(call.id);
      return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  return { message, usage: parseUsage(value.usage, ['prompt_tokens', 'completion_tokens']) };
}

function responseInput(messages: Message[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (message.role === 'assistant' && message.protocolOutput) return message.protocolOutput;
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' }];
    const input: unknown[] = [];
    if (message.content != null || !message.tool_calls?.length) input.push({ role: message.role, content: message.content ?? '' });
    for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id,
      name: call.function.name, arguments: call.function.arguments });
    return input;
  });
}

function parseResponseReply(value: unknown): Reply {
  const invalid = () => new Error('Invalid model response.');
  if (!record(value) || !Array.isArray(value.output) || value.error != null || value.status === 'failed' || value.status === 'cancelled') throw invalid();
  if (value.status !== undefined && value.status !== 'completed') throw new Error('Incomplete model response.');
  const content: string[] = [];
  const calls: NonNullable<Message['tool_calls']> = [];
  const ids = new Set<string>();
  for (const item of value.output) {
    if (!record(item) || typeof item.type !== 'string') throw invalid();
    if (item.type === 'reasoning') continue;
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw invalid();
      for (const part of item.content) {
        if (!record(part)) throw invalid();
        if (part.type === 'output_text' && typeof part.text === 'string') content.push(part.text);
        else if (part.type === 'refusal' && typeof part.refusal === 'string') content.push(part.refusal);
        else throw invalid();
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id.trim() || ids.has(item.call_id)
        || typeof item.name !== 'string' || !item.name.trim() || typeof item.arguments !== 'string') throw invalid();
      ids.add(item.call_id);
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else throw invalid();
  }
  return { message: { role: 'assistant', content: content.length ? content.join('\n') : null, protocolOutput: value.output,
    ...(calls.length ? { tool_calls: calls } : {}) }, usage: parseUsage(value.usage, ['input_tokens', 'output_tokens']) };
}

export function createHttpModel(options: { baseUrl: string; model: string; apiKey?: string; maxOutputTokens: number;
  protocol?: 'chat_completions' | 'responses' }): ModelClient {
  const protocol = options.protocol ?? 'chat_completions';
  const url = endpoint(options.baseUrl, protocol);
  if (!options.model.trim() || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
    throw new Error('Invalid model request configuration.');
  }
  return {
    async complete(messages, tools, signal) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify(protocol === 'responses'
            ? { model: options.model, input: responseInput(messages), stream: false, store: false,
              include: ['reasoning.encrypted_content'], max_output_tokens: options.maxOutputTokens,
              ...(tools.length ? { tools: tools.map((tool) => ({ type: tool.type, ...tool.function, strict: false })), tool_choice: 'auto', parallel_tool_calls: false } : {}) }
            : { model: options.model, messages: messages.map(({ protocolOutput: _, ...message }) => message), stream: false, max_tokens: options.maxOutputTokens,
              ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) }),
          signal,
          redirect: 'error',
        });
      } catch {
        throw new Error(signal.aborted ? 'Model request aborted.' : 'Model request failed.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Model request failed (HTTP ${response.status}).`);
      }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new Error(signal.aborted ? 'Model request aborted.' : 'Invalid model response.'); }
      return protocol === 'responses' ? parseResponseReply(value) : parseChatReply(value);
    },
  };
}
