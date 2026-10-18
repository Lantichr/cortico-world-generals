import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Core as CoreInstance } from 'cortico/core/core.ts';
import type { CoreConfig, Persona, World, WorldHost } from 'cortico/core/types.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';

class FixtureWorld implements World {
  readonly observed: boolean[] = [];
  readonly atStart: boolean[] = [];
  paused = false;
  throwOnPause = false;
  starting: (() => Promise<void>) | null = null;

  constructor(readonly id: string) {}
  envPromptVars(): Record<string, string> { return {}; }
  tools(): [] { return []; }
  onOperatorPausedChanged(paused: boolean): void {
    this.paused = paused;
    this.observed.push(paused);
    if (this.throwOnPause) throw new Error('fixture pause notification failure');
  }
  async start(_host: WorldHost): Promise<void> {
    this.atStart.push(this.paused);
    await this.starting?.();
  }
  async stop(): Promise<void> {}
}

function fixturePersona(memoryDir: string): Persona {
  return {
    memoryDir,
    blobs: {
      get: () => null,
      list: () => [],
      put: () => { throw new Error('No blobs are written by the host pause fixture'); },
    },
    attach: () => {},
    systemSegments: async () => [],
    declareSessions: () => [{
      id: 'fixture', label: 'Fixture', persistent: true, receivesEvents: true,
      rounds: () => ({ soft: 1, hard: 1 }), tools: () => [],
    }],
  };
}

export async function checkHostPause(sdkRoot: string, temporaryRoot: string): Promise<number> {
  const load = (file: string) => import(pathToFileURL(join(sdkRoot, 'src', file)).href);
  const [{ Core }, { CORE_DEFAULTS }, { WakeBus }, { nullLogger }] = await Promise.all([
    load('core/core.ts'), load('core/config.ts'), load('core/bus.ts'), load('core/util.ts'),
  ]) as [
    typeof import('cortico/core/core.ts'), typeof import('cortico/core/config.ts'),
    typeof import('cortico/core/bus.ts'), typeof import('cortico/core/util.ts'),
  ];
  let checks = 0;
  let deployments = 0;
  const llmCalls: string[] = [];
  const llm: ResponseClient = {
    respond: async () => {
      llmCalls.push('unexpected generation');
      throw new Error('Host lifecycle checks must not call a model');
    },
  };
  const check = async (name: string, body: () => Promise<void>): Promise<void> => {
    await body();
    checks++;
    console.log(`  passed: ${name}`);
  };
  const withCore = async (worlds: World[], body: (core: CoreInstance) => Promise<void>): Promise<void> => {
    const deployment = join(temporaryRoot, `deployment-${++deployments}`);
    const memoryDir = join(deployment, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const config: CoreConfig = structuredClone(CORE_DEFAULTS);
    config.displayName = 'Fixture';
    config.timezone = 'UTC';
    config.logging.stdout = 'error';
    const core = new Core({
      config, rootDir: deployment, memoryDir, dataDir: join(deployment, 'data'),
      repoRoot: sdkRoot, secret: () => '',
    }, { persona: fixturePersona(memoryDir), worlds, llm });
    try {
      await body(core);
    } finally {
      await core.stop();
    }
  };

  await check('WakeBus notifies synchronously before queued delivery and isolates listeners', async () => {
    const bus = new WakeBus(structuredClone(CORE_DEFAULTS.batching), nullLogger()) as InstanceType<typeof WakeBus> & {
      onPausedChanged(listener: (paused: boolean) => void): () => void;
    };
    const order: string[] = [];
    const removeFailing = bus.onPausedChanged(() => { throw new Error('fixture listener failure'); });
    const removeHealthy = bus.onPausedChanged((paused) => {
      assert.equal(bus.isPaused(), paused);
      order.push(`paused:${paused}`);
    });
    bus.setPaused(true);
    bus.setPaused(true);
    const batch = bus.nextBatch().then((items) => { order.push('delivered'); return items; });
    bus.push({ event: { cursor: 1, type: 'fixture.ready', source: 'fixture', origin: 'external',
      ts: '2026-01-01T00:00:00Z', text: 'fixture' } }, { trigger: 'flush' });
    assert.deepEqual(order, ['paused:true']);
    bus.setPaused(false);
    assert.deepEqual(order, ['paused:true', 'paused:false']);
    assert.equal((await batch).length, 1);
    assert.deepEqual(order, ['paused:true', 'paused:false', 'delivered']);
    removeFailing();
    removeHealthy();
    bus.setPaused(true);
    assert.deepEqual(order, ['paused:true', 'paused:false', 'delivered']);
  });

  await check('initial pause reaches a World before start', async () => {
    const world = new FixtureWorld('initial');
    await withCore([world], async (core) => {
      core.bus.setPaused(true);
      await core.start();
      assert.deepEqual(world.atStart, [true]);
      assert.deepEqual(world.observed, [true]);
    });
  });

  await check('initial running state, duplicate suppression, hidden Worlds and resume', async () => {
    const world = new FixtureWorld('hidden');
    await withCore([world], async (core) => {
      await core.start();
      core.setWorldVisible(world.id, false);
      core.bus.setPaused(false);
      core.bus.setPaused(true);
      core.bus.setPaused(true);
      core.bus.setPaused(false);
      assert.deepEqual(world.atStart, [false]);
      assert.deepEqual(world.observed, [false, true, false]);
      assert.equal(world.paused, false);
    });
  });

  await check('pause changes during initial asynchronous start reach the active lease', async () => {
    const world = new FixtureWorld('initial-starting');
    let release!: () => void;
    world.starting = () => new Promise<void>((resolve) => { release = resolve; });
    await withCore([world], async (core) => {
      const starting = core.start();
      assert.deepEqual(world.atStart, [false]);
      core.bus.setPaused(true);
      assert.equal(world.paused, true);
      release();
      await starting;
      assert.deepEqual(world.observed, [false, true]);
    });
  });

  await check('dynamic mount receives pause during start and unmount ends notifications', async () => {
    await withCore([], async (core) => {
      await core.start();
      core.bus.setPaused(true);
      const world = new FixtureWorld('mounted');
      let release!: () => void;
      world.starting = () => new Promise<void>((resolve) => { release = resolve; });
      const mounting = core.mountWorld(world);
      assert.deepEqual(world.atStart, [true]);
      core.bus.setPaused(false);
      assert.equal(world.paused, false);
      release();
      await mounting;
      assert.deepEqual(world.observed, [true, false]);
      await core.unmountWorld(world.id);
      core.bus.setPaused(true);
      assert.deepEqual(world.observed, [true, false]);
    });
  });

  await check('remounting the same instance supplies a fresh initial notification', async () => {
    await withCore([], async (core) => {
      await core.start();
      const world = new FixtureWorld('remounted');
      await core.mountWorld(world);
      await core.unmountWorld(world.id);
      await core.mountWorld(world);
      assert.deepEqual(world.atStart, [false, false]);
      assert.deepEqual(world.observed, [false, false]);
    });
  });

  await check('a throwing World is logged and cannot stop other notifications', async () => {
    const failing = new FixtureWorld('failing');
    failing.throwOnPause = true;
    const healthy = new FixtureWorld('healthy');
    await withCore([failing, healthy], async (core) => {
      const warnings: string[] = [];
      core.runlog.onWrite((entry) => {
        if (entry.msg.includes('暂停状态通知失败')) warnings.push(entry.msg);
      });
      await core.start();
      core.bus.setPaused(true);
      core.bus.setPaused(false);
      assert.deepEqual(failing.observed, [false, true, false]);
      assert.deepEqual(healthy.observed, [false, true, false]);
      assert.ok(warnings.length > 0);
      assert.ok(warnings.every((message) => message.includes(failing.id)));
    });
  });

  await check('failed startup deactivates the lease and stopping removes the subscription', async () => {
    const failed = new FixtureWorld('failed');
    failed.starting = async () => { throw new Error('fixture startup failure'); };
    await withCore([failed], async (core) => {
      await assert.rejects(core.start(), /fixture startup failure/);
      core.bus.setPaused(true);
      assert.deepEqual(failed.observed, [false]);
      await core.stop();
      core.bus.setPaused(false);
      assert.deepEqual(failed.observed, [false]);
    });
  });

  await check('stopping a running Core ends pause notifications', async () => {
    const world = new FixtureWorld('stopped');
    await withCore([world], async (core) => {
      await core.start();
      await core.stop();
      core.bus.setPaused(true);
      core.bus.setPaused(false);
      assert.deepEqual(world.observed, [false]);
    });
  });
  assert.deepEqual(llmCalls, [], 'No model request may occur during lifecycle checks');
  return checks;
}
