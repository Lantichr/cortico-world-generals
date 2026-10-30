/** Adds explicit backend defaults to a deployment config; dry-run unless --write is supplied. */
import { copyFileSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function migrateConfig(input, backend) {
  const result = structuredClone(input);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Config must be an object');
  result.worlds ??= {};
  result.worlds.generals ??= {};
  result.worlds.generals.agent ??= {};
  const agent = result.worlds.generals.agent;
  for (const value of [result.worlds, result.worlds.generals, agent]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('World config sections must be objects');
  }
  agent.backend = backend ?? agent.backend ?? 'legacy';
  agent.pythonExecutable ??= 'python';
  agent.pythonTimeoutMs ??= 5000;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), file = args[0];
  const options = args.slice(1);
  if (!file || options.some((value) => !['--write', '--city-half-1'].includes(value))) {
    throw new Error('Usage: node compat/migrate-city-half.mjs <config.json> [--city-half-1] [--write]');
  }
  const target = resolve(file), before = readFileSync(target, 'utf8'), parsed = JSON.parse(before);
  const result = migrateConfig(parsed, options.includes('--city-half-1') ? 'city-half-1' : undefined);
  if (JSON.stringify(parsed) === JSON.stringify(result)) console.log('Configuration already matches; no files changed.');
  else if (!options.includes('--write')) console.log(`Dry run: would update ${target}; use --write to create a backup and replace it.`);
  else {
    const nonce = randomUUID(), backup = `${target}.${nonce}.bak`, temporary = `${target}.${nonce}.tmp`;
    copyFileSync(target, backup);
    try {
      writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: statSync(target).mode });
      renameSync(temporary, target);
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    console.log(`Updated ${target}; backup: ${backup}`);
  }
}
