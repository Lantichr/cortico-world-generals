import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { EXTENSION_API_VERSIONS, parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import definition from '../src/index.ts';
import { GENERALS } from '../src/definition.ts';
import { GENERALS_DEFAULTS } from '../src/config.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let scratchDir: string;

beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'generals-definition-')); });
afterEach(() => { rmSync(scratchDir, { recursive: true, force: true }); });

describe('Generals extension contract', () => {
  it('publishes an ESM World entry accepted by the installed SDK manifest parser', () => {
    expect(definition).toBe(GENERALS);
    expect(parseExtensionManifest(packageJson)).toMatchObject({
      ok: true, manifest: { kind: 'world', api: EXTENSION_API_VERSIONS.world },
    });
    expect(packageJson.keywords).toContain('cortico-world');
  });

  it('passes SDK dry mounting with default configuration and no account secret', async () => {
    const report = await dryMountWorld(definition, { scratchDir, packageDir });
    expect(report.failures).toEqual([]);
  });

  it('returns independent nested configuration objects for each deployment', () => {
    const first = definition.defaults();
    const second = definition.defaults();
    first.agent.maxSearchNodes++;
    first.viewer.port++;
    expect(second).toEqual(GENERALS_DEFAULTS);
    expect(definition.defaults()).toEqual(GENERALS_DEFAULTS);
  });

  it('resolves the environment prompt and child entry inside the package', () => {
    const world = definition.create(fakeWorldContext(definition, { scratchDir, packageDir }));
    const prompt = world.webUi!().promptDocs!.find((doc) => doc.role === 'envPrompt')!;
    expect(readFileSync(prompt.path, 'utf8').trim().length).toBeGreaterThan(0);
    expect(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url))).toBe(prompt.path);
    expect(readFileSync(new URL('../src/engine-child.ts', import.meta.url), 'utf8').length).toBeGreaterThan(0);
  });
});
