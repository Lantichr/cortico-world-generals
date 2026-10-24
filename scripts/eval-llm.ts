import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './llm-suite/config.ts';
import { suitePrompt } from './llm-suite/prompt.ts';
import { createHttpModel } from './llm-suite/provider.ts';
import { runCase, type CaseResult } from './llm-suite/runner.ts';
import { gameScenarios, snapshotScenarios } from './llm-suite/scenarios.ts';
import { createScriptedModel } from './llm-suite/scripted.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  if (args.includes('--help')) {
    process.stdout.write('pnpm eval:llm --config <JSON file> --out <new directory> [--mode scripted|llm] [--suite all|snapshots|games]\n');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--out', '--mode', '--suite'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid CLI arguments; use --help.');
    values[args[i].slice(2)] = args[i + 1];
  }
  if (!values.out) throw new Error('--out is required; use a directory under scratch/.');
  let input: unknown = {};
  if (values.config) {
    try { input = JSON.parse(readFileSync(resolve(values.config), 'utf8')); }
    catch { throw new Error('Cannot read suite config JSON.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Suite config must be an object.');
  const config = parseConfig({ ...input, ...(values.mode ? { mode: values.mode } : {}), ...(values.suite ? { suite: values.suite } : {}) });
  const apiKey = config.mode === 'llm' && config.model?.apiKeyEnv ? process.env[config.model.apiKeyEnv] : undefined;
  if (config.mode === 'llm' && config.model?.apiKeyEnv && !apiKey) throw new Error('Configured API key environment variable is empty.');
  const model = config.mode === 'llm' ? createHttpModel({ ...config.model!, apiKey }) : createScriptedModel();
  const prompt = suitePrompt(), runId = randomUUID(), outDir = resolve(values.out);
  let gitRevision = 'unknown', gitDirty: boolean | null = null;
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    gitDirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  catch { /* Source archives have no Git metadata. */ }
  const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  const hashes = [...sourceFiles(resolve(root, 'src')), ...sourceFiles(resolve(root, 'scripts/llm-suite')),
    resolve(root, 'scripts/eval-llm.ts'), resolve(root, 'tests/agent/ffa-arena.ts')].sort().map((path) => ({
      file: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }));
  mkdirSync(outDir, { recursive: true });
  const eventsFile = resolve(outDir, 'events.jsonl');
  // Exclusive creation prevents accidental mixing of two runs in one output directory.
  writeFileSync(eventsFile, '', { flag: 'wx' });
  const log = (event: Record<string, unknown>) => appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
  const manifest = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), gitRevision, gitDirty, sourceHashes: hashes,
    config, promptHash: createHash('sha256').update(prompt).digest('hex'), prompt,
    toolsVersion: 1, referee: 'FfaArena', opponent: 'observation-only pusher',
    limitations: ['rotating initiative, not official dependency resolution', 'no network queue or AFK',
      'fixed maps and rule opponents do not measure human strength', 'snapshot reference choices are non-exclusive heuristics'],
  };
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log({ kind: 'run_start', ...manifest });
  const results: CaseResult[] = [];
  const cases = [
    ...(config.suite !== 'games' ? snapshotScenarios().map((scenario) => ({ scenario, kind: 'snapshot' as const })) : []),
    ...(config.suite !== 'snapshots' ? gameScenarios().map((scenario) => ({ scenario, kind: 'game' as const })) : []),
  ];
  for (let repetition = 1; repetition <= config.repetitions; repetition++) for (const { scenario, kind } of cases) {
    for (const variant of ['s1', config.mode] as const) {
      process.stdout.write(`${kind} ${scenario.id} ${variant} #${repetition}\n`);
      results.push(await runCase({ scenario, kind, variant, repetition, gameId: `${runId}/${scenario.id}/${repetition}/${variant}`,
        config, prompt, ...(variant === 's1' ? {} : { model }), log }));
      writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify({ schemaVersion: 1, runId, results }, null, 2)}\n`);
    }
  }
  const comparison = gameScenarios().flatMap((scenario) => Array.from({ length: config.repetitions }, (_, i) => {
    const pair = results.filter((result) => result.kind === 'game' && result.scenario === scenario.id && result.repetition === i + 1);
    return { scenario: scenario.id, repetition: i + 1, s1: pair.find((result) => result.variant === 's1'),
      s2: pair.find((result) => result.variant === config.mode) };
  })).filter((pair) => pair.s1 && pair.s2);
  const totals = ['s1', config.mode].map((variant) => {
    const games = results.filter((result) => result.kind === 'game' && result.variant === variant);
    return { variant, wins: games.filter((result) => result.outcome === 'win').length,
      losses: games.filter((result) => result.outcome === 'loss').length,
      unfinished: games.filter((result) => result.outcome === 'unfinished').length,
      modelCalls: games.reduce((sum, result) => sum + result.modelCalls, 0),
      tokens: games.reduce((sum, result) => sum + result.inputTokens + result.outputTokens, 0) };
  });
  const summary = { schemaVersion: 1, runId, finishedAt: new Date().toISOString(), totals, comparison, results };
  writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log({ kind: 'run_end', totals });
  process.stdout.write(`${JSON.stringify(totals)}\n${resolve(outDir, 'summary.json')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Suite failed.'}\n`);
  process.exitCode = 1;
});
