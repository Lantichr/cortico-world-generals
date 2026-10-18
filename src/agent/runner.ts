import { GeneralsAgent } from './agent.ts';
import type { AgentDecision, AgentObservation, AgentOptions } from './contracts.ts';

export interface AgentTransport {
  observations: AsyncIterable<AgentObservation>;
  execute(decision: Extract<AgentDecision, { kind: 'move' }>): Promise<void>;
  onDecision?(decision: AgentDecision): void;
}

/** A transport supplies authoritative frames and applies its own revision and ownership checks. */
export async function runGeneralsAgent(transport: AgentTransport, options: AgentOptions, signal?: AbortSignal): Promise<void> {
  const agent = new GeneralsAgent(options);
  const iterator = transport.observations[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const aborted = new Promise<IteratorResult<AgentObservation>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined });
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (!signal?.aborted) {
      const frame = await Promise.race([iterator.next(), aborted]);
      if (frame.done || signal?.aborted) break;
      const decision = agent.decide(frame.value);
      transport.onDecision?.(decision);
      if (signal?.aborted) break;
      if (decision.kind === 'move') await transport.execute(decision);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (iterator.return) await Promise.race([iterator.return(), aborted]);
  }
}
