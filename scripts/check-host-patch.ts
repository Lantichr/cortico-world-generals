/** Applies the host compatibility patch to an isolated installed SDK copy and checks real lifecycle behavior. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHostPause } from './fixtures/host-pause.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const installed = dirname(fileURLToPath(import.meta.resolve('cortico/package.json')));
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
  name: string; version: string; dependencies: Record<string, string>;
};
assert.equal(manifest.name, 'cortico');
assert.equal(manifest.version, '0.2.3', 'The compatibility patch is verified against Cortico 0.2.3');
const patchFile = join(root, 'compat', 'host-operator-pause.patch');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cortico-generals-host-patch-')));
const copiedSdk = join(temporary, 'sdk');
const affected = ['src/core/bus.ts', 'src/core/core.ts', 'src/core/types.ts'];
const before = affected.map((file) => readFileSync(join(installed, file)));

try {
  cpSync(installed, copiedSdk, {
    recursive: true,
    filter: (source) => !['node_modules', '.git'].includes(basename(source)),
  });
  const sdkRequire = createRequire(join(installed, 'package.json'));
  for (const name of Object.keys(manifest.dependencies)) {
    const source = sdkRequire.resolve.paths(name)?.map((candidate) => join(candidate, name)).find(existsSync);
    assert.ok(source, `Installed SDK dependency is missing: ${name}`);
    const target = join(temporary, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', copiedSdk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git(['apply', '--check', patchFile]);
  git(['apply', patchFile]);
  for (const [index, file] of affected.entries()) {
    assert.notDeepEqual(readFileSync(join(copiedSdk, file)), before[index], `${file} must be patched`);
  }
  const checks = await checkHostPause(copiedSdk, temporary);
  for (const [index, file] of affected.entries()) {
    assert.deepEqual(readFileSync(join(installed, file)), before[index], `Installed ${file} must stay unchanged`);
  }
  console.log(`Host patch: git apply --check and ${checks} Core/WakeBus checks passed against Cortico ${manifest.version}.`);
} finally {
  const target = resolve(temporary);
  const expectedParent = realpathSync(tmpdir());
  assert.ok(target.startsWith(`${expectedParent}${sep}`), 'Cleanup target must stay in the system temporary directory');
  assert.ok(basename(target).startsWith('cortico-generals-host-patch-'), 'Cleanup target must be the directory created by this check');
  rmSync(target, { recursive: true, force: true });
}
