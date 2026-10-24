/** Checks the npm tarball against the installed Cortico SDK using loopback services only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { ToolCallContext, World, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { parseExtensionManifest, type ExtensionPackageJson } from 'cortico/extensions/manifest.ts';
import { checkDescribe } from 'cortico/extensions/describe-export.ts';
import { registerFrameworkResolver } from 'cortico/extensions/runtime.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GeneralsConfigSection } from '../src/config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'cortico-generals-package-'));
const packedRoot = join(temporary, 'package');
const required = [
  'package.json', 'README.md', 'README_zh.md', 'LICENSE',
  'describe.json',
  'src/index.ts', 'src/definition.ts', 'src/config.ts', 'src/world.ts', 'src/proxy.ts',
  'src/engine-child.ts', 'src/engine-ipc.ts', 'src/ENV_PROMPT.md',
  'src/agent/agent.ts', 'src/viewer/server.ts', 'src/viewer/contracts.ts',
  'src/viewer/web/index.html', 'src/viewer/web/app.js', 'src/viewer/web/styles.css',
  'docs/host-compatibility.md', 'docs/releasing.md', 'compat/host-operator-pause.patch',
];

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

function pack(): PackResult {
  let output: string;
  if (process.platform === 'win32') {
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c',
      `npm pack --json --ignore-scripts --pack-destination "${temporary}"`], {
      cwd: root, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    output = result.stdout;
  } else {
    output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' });
  }
  const results = JSON.parse(output) as PackResult[];
  assert.equal(results.length, 1, 'npm pack must produce one tarball');
  return results[0];
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'Package smoke check timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function smoke(definition: WorldDefinition<GeneralsConfigSection>): Promise<void> {
  const protocol = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const packets: unknown[][] = [];
  let peer: WebSocket | undefined;
  let world: World | undefined;
  protocol.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      const packet = data.toString();
      if (packet === '40') socket.send('40{"sid":"package-namespace"}');
      else if (packet.startsWith('42')) packets.push(JSON.parse(packet.slice(2)) as unknown[]);
    });
    socket.send('0{"sid":"package-smoke","pingInterval":30000,"pingTimeout":10000}');
  });
  try {
    await once(protocol, 'listening');
    const context = fakeWorldContext(definition, { scratchDir: join(temporary, 'smoke'), packageDir: packedRoot });
    context.cfg.serverUrl = `ws://127.0.0.1:${(protocol.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket`;
    context.cfg.connectTimeoutMs = 5000;
    context.cfg.snapshotIntervalMs = 0;
    context.cfg.viewer = { enabled: true, port: 0 };
    context.secret = () => 'package-smoke-account';
    const store = new JsonlEventStore({ dataDir: join(temporary, 'events'), run: 'r-20260101-000000-package' });
    const host: WorldHost = {
      store, log: nullLogger(),
      modelFacts: { model: () => 'fixture', accepts: () => false, contextWindow: () => undefined },
      pushEvent: async (event) => store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined }),
      pushDeferred: () => {}, drainPendingEvents: async () => [], blob: () => null, reportUsage: () => {},
    };
    world = definition.create(context);
    const running = world;
    const callContext: ToolCallContext = { role: 'fixture', log: nullLogger() };
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const tool = running.tools().find((candidate) => candidate.name === `generals_${name}`);
      assert.ok(tool, `Missing generals_${name}`);
      const result = await tool.handler(args, callContext);
      assert.ok(typeof result !== 'object' || result === null || !('failed' in result) || !result.failed,
        `generals_${name} failed: ${JSON.stringify(result)}`);
      return result;
    };
    const declaration = () => running.webUi?.('en');
    await world.start(host);
    await until(() => Boolean(declaration()?.links?.length));
    const viewerUrl = declaration()!.links![0].href;
    for (const path of ['/viewer', '/viewer/app.js', '/viewer/styles.css']) {
      const response = await fetch(new URL(path, viewerUrl), { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `Missing packed viewer asset ${path}`);
      assert.ok((await response.text()).length > 0);
    }
    await call('join_private', { room: 'package-smoke' });
    await until(() => packets.some(([name]) => name === 'join_private'));
    assert.ok(peer);
    const send = (name: string, payload: unknown) => peer!.send(`42${JSON.stringify([name, payload])}`);
    send('game_start', { playerIndex: 0, replay_id: 'package-smoke', teams: [1, 2], options: { modifiers: [] } });
    const map = [3, 1, 12, 0, 7, 0, -1, 1];
    send('game_update', {
      turn: 1, map_diff: [0, map.length, ...map], cities_diff: [0, 0], generals: [0, 2],
      scores: [{ i: 0, total: 12, tiles: 1 }, { i: 1, total: 7, tiles: 1 }],
    });
    await until(async () => JSON.parse(await call('observe') as string).view?.turn === 1);
    await call('attack', { from: 0, to: 1 });
    await until(() => packets.some(([name]) => name === 'attack'));
    assert.deepEqual(packets.find(([name]) => name === 'attack'), ['attack', 0, 1, false, 1]);
    const state = await fetch(new URL('/api/state', viewerUrl), { signal: AbortSignal.timeout(5000) });
    assert.equal(state.status, 200);
    const snapshot = await state.json() as { turn: number; board: { width: number; height: number } };
    assert.equal(snapshot.turn, 1);
    assert.equal(snapshot.board.width, 3);
    assert.equal(snapshot.board.height, 1);
    const streamController = new AbortController();
    const timer = setTimeout(() => streamController.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const stream = await fetch(new URL('/stream', viewerUrl), { signal: streamController.signal });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
      reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let frame = '';
      while (!frame.includes('\n\n')) {
        const chunk = await reader.read();
        assert.ok(!chunk.done, 'Viewer stream ended before its initial frame');
        frame += decoder.decode(chunk.value, { stream: true });
      }
      frame = frame.slice(0, frame.indexOf('\n\n'));
      assert.match(frame, /^data: /);
      assert.equal((JSON.parse(frame.slice(6).trim()) as { turn: number }).turn, 1);
    } finally {
      clearTimeout(timer);
      streamController.abort();
      await reader?.cancel().catch(() => {});
    }
    await call('start_agent');
    const attacks = () => packets.filter(([name]) => name === 'attack').length;
    const manualAttacks = attacks();
    const agentMap = [3, 1, 20, 0, 0, 0, -1, 1];
    send('game_update', {
      turn: 2, map_diff: [0, agentMap.length, ...agentMap], cities_diff: [0, 0], generals: [0, 2], attackIndex: 1,
      scores: [{ i: 0, total: 20, tiles: 1 }, { i: 1, total: 0, tiles: 1 }],
    });
    await until(() => attacks() > manualAttacks);
    assert.equal(JSON.parse(await call('agent_status') as string).operatorPauseLinked, false);
    await call('stop_agent');
    assert.equal(JSON.parse(await call('agent_status') as string).control, 'manual');
    const stoppedAttacks = attacks();
    send('game_update', {
      turn: 3, map_diff: [0, agentMap.length, ...agentMap], cities_diff: [0, 0], generals: [0, 2], attackIndex: 2,
      scores: [{ i: 0, total: 20, tiles: 1 }, { i: 1, total: 0, tiles: 1 }],
    });
    await until(async () => JSON.parse(await call('observe') as string).view.turn === 3);
    assert.equal(attacks(), stoppedAttacks, 'Revoking S1 must stop autonomous moves without pause integration');
    assert.ok(!store.range({ source: 'generals' }).some((event) => event.text.includes('package-smoke-account')),
      'Account credentials must not appear in events');
  } finally {
    try {
      await world?.stop();
    } finally {
      for (const socket of protocol.clients) socket.terminate();
      await new Promise<void>((done) => protocol.close(() => done()));
    }
  }
}

try {
  const packed = pack();
  const files = new Set(packed.files.map(({ path }) => path));
  for (const file of required) assert.ok(files.has(file), `npm tarball is missing ${file}`);
  for (const file of files) {
    assert.ok(!/(^|\/)(?:node_modules|\.git|scratch|deployments)(\/|$)/.test(file), `Private directory in tarball: ${file}`);
    assert.ok(!/(^|\/)\.env(?:\.|$)/.test(file), `Environment file in tarball: ${file}`);
  }
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  symlinkSync(resolve(root, 'node_modules'), join(packedRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(readFileSync(join(packedRoot, 'package.json'), 'utf8')) as ExtensionPackageJson;
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as ExtensionPackageJson;
  assert.equal(manifest.name, sourceManifest.name);
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.main, './src/index.ts');
  const parsed = parseExtensionManifest(manifest);
  assert.ok(parsed.ok, parsed.ok ? undefined : parsed.reasons.join('\n'));
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.manifest.kind, 'world');
  registerFrameworkResolver();
  const definition = (await import(pathToFileURL(join(packedRoot, 'src/index.ts')).href)).default as WorldDefinition<GeneralsConfigSection>;
  assert.equal(definition.id, 'generals');
  const report = await dryMountWorld(definition as unknown as WorldDefinition<WorldSection>, {
    scratchDir: join(temporary, 'dry-mount'), packageDir: packedRoot,
  });
  assert.deepEqual(report.failures, []);
  for (const warning of report.warnings) console.warn(warning);
  const described = await checkDescribe('world', definition, parsed.manifest.describe, {
    scratchDir: join(temporary, 'describe'), packageDir: packedRoot,
  });
  assert.deepEqual(described.failures, []);
  assert.deepEqual(described.warnings, []);
  assert.ok(existsSync(join(packedRoot, 'src/ENV_PROMPT.md')));
  await smoke(definition);
  console.log(`${manifest.name}@${manifest.version}: npm tarball, dry mount, engine, manual move, unpatched-host S1, viewer and SSE passed`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
