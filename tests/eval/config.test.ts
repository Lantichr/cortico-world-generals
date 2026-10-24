import { describe, expect, it } from 'vitest';
import { parseConfig, SUITE_DEFAULTS } from '../../scripts/llm-suite/config.ts';

const model = { baseUrl: 'https://model.example.invalid/v1', model: 'fixture-strategist', protocol: 'responses',
  apiKeyEnv: 'CORTICO_SUITE_API_KEY', maxOutputTokens: 400 };

describe('standalone suite configuration', () => {
  it('uses exported defaults and preserves independent overrides', () => {
    expect(parseConfig({})).toEqual(SUITE_DEFAULTS);
    expect(parseConfig({ suite: 'snapshots', timing: 'paused', repetitions: 2 })).toEqual({
      ...SUITE_DEFAULTS, suite: 'snapshots', timing: 'paused', repetitions: 2,
    });
    expect(parseConfig({})).not.toBe(SUITE_DEFAULTS);
  });

  it.each([undefined, null, false, 0, 'config', []])('rejects non-object configuration %#', (input) => {
    expect(() => parseConfig(input)).toThrow('Suite config must be an object.');
  });

  it.each(['mode', 'suite', 'timing'] as const)('rejects null and coerced values for %s', (key) => {
    for (const value of [null, 0, false, [], {}, 'unsupported', [SUITE_DEFAULTS[key]]]) {
      expect(() => parseConfig({ [key]: value })).toThrow(`Invalid suite config: ${key}`);
    }
  });

  it('accepts every declared enum choice', () => {
    for (const mode of ['scripted', 'llm']) expect(parseConfig({ mode, model }).mode).toBe(mode);
    for (const suite of ['snapshots', 'games', 'all']) expect(parseConfig({ suite }).suite).toBe(suite);
    for (const timing of ['paused', 'realtime']) expect(parseConfig({ timing }).timing).toBe(timing);
  });

  it.each(['extra', 'apiKey', 'constructor', 'toString', '__proto__'])('rejects unknown and inherited top-level keys: %s', (key) => {
    const input = JSON.parse(`{"${key}":"fixture"}`);
    expect(() => parseConfig(input)).toThrow(`Unknown suite config: ${key}`);
  });

  const limits: Array<[string, number, number]> = [
    ['tickMs', 0, 10_000], ['maxTurns', 1, 100_000], ['snapshotTurns', 0, 1000], ['reportIntervalTurns', 1, 10_000],
    ['minReportTurns', 1, 10_000], ['requestTimeoutMs', 1, 300_000], ['maxModelCalls', 1, 1000], ['maxToolRounds', 1, 32],
    ['maxToolCalls', 1, 128], ['maxContextChars', 1000, 2_000_000], ['repetitions', 1, 100], ['decisionBudgetMs', 1, 1000],
    ['maxSearchNodes', 1, 100_000],
  ];

  it.each(limits)('accepts inclusive numeric limits for %s', (key, min, max) => {
    expect(parseConfig({ [key]: min })).toHaveProperty(key, min);
    expect(parseConfig({ [key]: max })).toHaveProperty(key, max);
  });

  it.each(limits)('rejects out-of-range or non-integer %s', (key, min, max) => {
    for (const value of [min - 1, max + 1, min + 0.5, null, String(min), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseConfig({ [key]: value })).toThrow(`Invalid suite config: ${key}`);
    }
  });

  it('requires model configuration for LLM mode and accepts all declared protocols', () => {
    expect(() => parseConfig({ mode: 'llm' })).toThrow('LLM mode requires model config.');
    for (const protocol of ['chat_completions', 'responses', 'gemini_interactions']) {
      expect(parseConfig({ mode: 'llm', model: { ...model, protocol } }).model).toEqual({ ...model, protocol });
    }
    expect(parseConfig({ model }).model).toEqual(model);
  });

  it.each(['scripted', 'llm'])('validates model endpoints before a %s configuration can be logged', (mode) => {
    for (const baseUrl of ['', 'not a URL', 'http://model.example.invalid/v1', 'ftp://localhost/v1',
      'https://name:fixture-secret@model.example.invalid/v1', 'https://@model.example.invalid/v1',
      'https://model.example.invalid/v1?key=fixture-secret', 'https://model.example.invalid/v1?',
      'https://model.example.invalid/v1#fixture-secret', 'https://model.example.invalid/v1#']) {
      expect(() => parseConfig({ mode, model: { ...model, baseUrl } })).toThrow(/^Invalid model endpoint URL\.$/);
    }
    for (const baseUrl of ['https://model.example.invalid/v1', 'http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1']) {
      expect(parseConfig({ mode, model: { ...model, baseUrl } }).model?.baseUrl).toBe(baseUrl);
    }
  });

  it.each([null, false, 0, '', 'model', [], {}])('rejects explicit invalid nested model configuration %#', (input) => {
    expect(() => parseConfig({ model: input })).toThrow('Invalid model config.');
  });

  it('validates nested model fields and its output-token limit', () => {
    const invalid = [{ baseUrl: null }, { baseUrl: 12 }, { model: null }, { model: ' ' }, { protocol: null },
      { protocol: ['responses'] }, { protocol: 'other' }, { maxOutputTokens: null }, { maxOutputTokens: '400' },
      { maxOutputTokens: 0 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxOutputTokens: 1.5 },
      { maxOutputTokens: Number.NaN }, { maxOutputTokens: Number.POSITIVE_INFINITY }];
    for (const fields of invalid) expect(() => parseConfig({ model: { ...model, ...fields } })).toThrow('Invalid model config.');
    for (const maxOutputTokens of [1, 100_000, 393_216]) {
      expect(parseConfig({ model: { ...model, maxOutputTokens } }).model?.maxOutputTokens).toBe(maxOutputTokens);
    }
  });

  it.each([
    { protocol: 'chat_completions', thinking: 'enabled', reasoningEffort: 'low', maxTokensParameter: 'max_tokens' },
    { protocol: 'chat_completions', enableThinking: true, preserveThinking: true, reasoningEffort: 'xhigh', maxTokensParameter: 'max_completion_tokens' },
    { protocol: 'chat_completions', enableThinking: true, thinkingBudget: 0 },
    { protocol: 'chat_completions', enableThinking: false, preserveThinking: false, reasoningEffort: 'none' },
    { protocol: 'responses', reasoningEffort: 'high' },
    { protocol: 'gemini_interactions', reasoningEffort: 'minimal' },
    { protocol: 'gemini_interactions', reasoningEffort: 'medium' },
  ])('preserves explicit protocol options %#', (fields) => {
    expect(parseConfig({ model: { ...model, ...fields } }).model).toEqual({ ...model, ...fields });
  });

  it.each([
    { reasoningEffort: '' }, { reasoningEffort: null }, { reasoningEffort: 'HIGH' }, { reasoningEffort: [] },
    { maxTokensParameter: null }, { maxTokensParameter: 'max_output_tokens' },
    { thinking: true }, { thinking: 'auto' }, { enableThinking: null }, { enableThinking: 'true' },
    { preserveThinking: null }, { preserveThinking: 1 },
    { thinkingBudget: null }, { thinkingBudget: -1 }, { thinkingBudget: 0.5 }, { thinkingBudget: Number.MAX_SAFE_INTEGER + 1 },
    { reasoningEffort: 'low', thinkingBudget: 2048 },
    { thinking: 'enabled', enableThinking: true },
    { thinking: 'disabled', reasoningEffort: 'low' }, { enableThinking: false, reasoningEffort: 'high' },
    { thinking: 'enabled', reasoningEffort: 'none' }, { enableThinking: true, reasoningEffort: 'none' },
    { thinking: 'disabled', thinkingBudget: 2048 }, { enableThinking: false, thinkingBudget: 2048 },
  ])('rejects invalid or contradictory Chat options before a request %#', (fields) => {
    expect(() => parseConfig({ model: { ...model, protocol: 'chat_completions', ...fields } }))
      .toThrow('Invalid model request configuration.');
  });

  it.each(['responses', 'gemini_interactions'])('rejects ignored Chat-only options for %s', (protocol) => {
    for (const fields of [{ maxTokensParameter: 'max_tokens' }, { thinking: 'enabled' }, { enableThinking: true },
      { preserveThinking: true }, { thinkingBudget: 2048 }]) {
      expect(() => parseConfig({ model: { ...model, protocol, ...fields } })).toThrow('Invalid model request configuration.');
    }
  });

  it.each(['none', 'xhigh', 'max', 'ultra'])('rejects an unsupported native thinking level %s', (reasoningEffort) => {
    expect(() => parseConfig({ model: { ...model, protocol: 'gemini_interactions', reasoningEffort } }))
      .toThrow('Invalid model request configuration.');
  });

  it('accepts only a named CORTICO environment variable for credentials', () => {
    const { apiKeyEnv: _, ...withoutKey } = model;
    expect(parseConfig({ model: withoutKey }).model).toEqual(withoutKey);
    expect(parseConfig({ model }).model?.apiKeyEnv).toBe(model.apiKeyEnv);
    for (const apiKeyEnv of [null, false, 12, '', 'CORTICO_', 'OTHER_KEY', 'CORTICO_lowercase', 'CORTICO_KEY WITH SPACE', 'fixture-secret-value']) {
      expect(() => parseConfig({ model: { ...model, apiKeyEnv } })).toThrow('Invalid model config.');
    }
    for (const key of ['apiKey', 'key', 'extra', 'constructor', 'toString', '__proto__']) {
      const fields = JSON.parse(`{"${key}":"fixture-secret-value"}`);
      expect(() => parseConfig({ model: { ...model, ...fields } })).toThrow('Invalid model config.');
    }
  });
});
