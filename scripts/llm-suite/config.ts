import { createHttpModel } from './provider.ts';

export interface SuiteConfig {
  mode: 'scripted' | 'llm';
  suite: 'snapshots' | 'games' | 'all';
  timing: 'paused' | 'realtime';
  tickMs: number;
  maxTurns: number;
  snapshotTurns: number;
  reportIntervalTurns: number;
  minReportTurns: number;
  requestTimeoutMs: number;
  maxModelCalls: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxContextChars: number;
  repetitions: number;
  decisionBudgetMs: number;
  maxSearchNodes: number;
  model?: { baseUrl: string; model: string; protocol: 'chat_completions' | 'responses'; apiKeyEnv?: string; maxOutputTokens: number };
}

export const SUITE_DEFAULTS: SuiteConfig = {
  mode: 'scripted', suite: 'all', timing: 'realtime', tickMs: 500,
  maxTurns: 1200, snapshotTurns: 12, reportIntervalTurns: 20, minReportTurns: 4,
  requestTimeoutMs: 20_000, maxModelCalls: 16, maxToolRounds: 6, maxToolCalls: 24,
  maxContextChars: 120_000, repetitions: 1, decisionBudgetMs: 20, maxSearchNodes: 2400,
};

/** Configuration is independent of Cortico deployments and contains no literal API key. */
export function parseConfig(input: unknown): SuiteConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Suite config must be an object.');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!Object.hasOwn(SUITE_DEFAULTS, key) && key !== 'model') throw new Error(`Unknown suite config: ${key}`);
  const config = { ...SUITE_DEFAULTS, ...value } as SuiteConfig;
  for (const [key, choices] of Object.entries({ mode: ['scripted', 'llm'], suite: ['snapshots', 'games', 'all'], timing: ['paused', 'realtime'] })) {
    if (!choices.includes(config[key as keyof SuiteConfig] as string)) throw new Error(`Invalid suite config: ${key}`);
  }
  const limits: Record<string, [number, number]> = {
    tickMs: [0, 10_000], maxTurns: [1, 100_000], snapshotTurns: [0, 1000], reportIntervalTurns: [1, 10_000],
    minReportTurns: [1, 10_000], requestTimeoutMs: [1, 300_000], maxModelCalls: [1, 1000], maxToolRounds: [1, 32],
    maxToolCalls: [1, 128], maxContextChars: [1000, 2_000_000], repetitions: [1, 100], decisionBudgetMs: [1, 1000], maxSearchNodes: [1, 100_000],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = config[key as keyof SuiteConfig];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid suite config: ${key}`);
  }
  if (config.mode === 'llm' && !config.model) throw new Error('LLM mode requires model config.');
  if (config.model !== undefined) {
    const model = config.model;
    if (!model || typeof model !== 'object' || Array.isArray(model)
      || Object.keys(model).some((key) => !['baseUrl', 'model', 'protocol', 'apiKeyEnv', 'maxOutputTokens'].includes(key))
      || typeof model.baseUrl !== 'string' || typeof model.model !== 'string' || !model.model.trim()
      || !['chat_completions', 'responses'].includes(model.protocol)
      || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 100_000
      || model.apiKeyEnv !== undefined && (typeof model.apiKeyEnv !== 'string' || !/^CORTICO_[A-Z0-9_]+$/.test(model.apiKeyEnv))) {
      throw new Error('Invalid model config.');
    }
    createHttpModel(model);
  }
  return config;
}
