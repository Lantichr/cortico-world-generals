import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

it('migrates a real config only with --write, preserves overrides and backs up original bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generals-config-'));
  const file = join(dir, 'config.json');
  const input = { worlds: { generals: { enabled: true, agent: { decisionBudgetMs: 70, pythonExecutable: 'custom-python' } } }, persona: { setting: 'retained' } };
  const before = JSON.stringify(input);
  writeFileSync(file, before);
  const run = (...args: string[]) => spawnSync(process.execPath,
    [fileURLToPath(new URL('../compat/migrate-city-half.mjs', import.meta.url)), file, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    expect(run('--city-half-1').status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['config.json']);
    expect(run('--city-half-1', '--write').status).toBe(0);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after).toMatchObject(input);
    expect(after.worlds.generals.agent).toMatchObject({ backend: 'city-half-1', pythonTimeoutMs: 5000 });
    const backups = readdirSync(dir).filter((entry) => entry.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(before);
    expect(run('--write').status).toBe(0);
    expect(readdirSync(dir).filter((entry) => entry.endsWith('.bak'))).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
