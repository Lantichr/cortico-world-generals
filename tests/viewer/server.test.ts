import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeneralsViewerSnapshot } from '../../src/viewer/contracts.ts';
import { GeneralsViewerServer } from '../../src/viewer/server.ts';

const servers: GeneralsViewerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function snapshot(turn = 1): GeneralsViewerSnapshot {
  return {
    phase: 'playing', connected: true, control: 'autonomous', paused: false,
    turn, playerIndex: 0, board: null, players: [], selected: null, queuedMoves: [], plan: null,
  };
}

async function start(getSnapshot = () => snapshot(), port = 0): Promise<GeneralsViewerServer> {
  const server = new GeneralsViewerServer({ preferredPort: port, snapshot: getSnapshot });
  servers.push(server);
  await server.start();
  return server;
}

function baseUrl(server: GeneralsViewerServer): string {
  return new URL(server.viewerUrl).origin;
}

describe('Generals read-only viewer server', () => {
  it('serves the viewer assets and current observation from one loopback origin', async () => {
    const server = await start();
    expect(server.running).toBe(true);
    expect(server.viewerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/viewer$/);
    for (const [path, mime] of [
      ['/viewer', 'text/html'],
      ['/viewer/app.js', 'text/javascript'],
      ['/viewer/styles.css', 'text/css'],
    ]) {
      const response = await fetch(`${baseUrl(server)}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(mime);
      expect(response.headers.get('cache-control'), path).toContain('no-store');
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull();
      expect((await response.text()).length, path).toBeGreaterThan(0);
    }
    const state = await fetch(`${baseUrl(server)}/api/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual(snapshot());
  });

  it('rejects cross-origin reads, foreign Host values, writes and unlisted paths', async () => {
    const server = await start();
    const url = `${baseUrl(server)}/api/state`;
    const crossOriginHeaders: Record<string, string>[] = [
      { Origin: 'https://outside.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of crossOriginHeaders) {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await httpStatus(url, { Host: 'outside.example' })).toBe(403);
    const local = await fetch(url, { headers: { Origin: baseUrl(server) } });
    expect(local.status).toBe(200);
    const write = await fetch(url, { method: 'POST', body: '{}' });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET');
    expect((await fetch(`${baseUrl(server)}/viewer/server.ts`)).status).toBe(404);
    expect((await fetch(`${baseUrl(server)}/viewer/%2e%2e/contracts.ts`)).status).toBe(404);
  });

  it('streams the latest complete state on admission and on publish, then closes on stop', async () => {
    let current = snapshot(3);
    const server = await start(() => current);
    const response = await fetch(`${baseUrl(server)}/stream`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const reader = response.body!.getReader();
    const read = sseReader(reader);
    expect(await read()).toEqual(current);
    current = { ...snapshot(4), selected: { index: 7, half: true }, queuedMoves: [{ from: 6, to: 7, half: true, attackIndex: 9 }] };
    server.publish();
    expect(await read()).toEqual(current);
    await server.stop();
    expect(server.running).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });

  it('keeps the requested fixed port and reports a conflict without choosing another port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const server = new GeneralsViewerServer({ preferredPort: port, snapshot });
    servers.push(server);
    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(server.running).toBe(false);
      expect(server.viewerUrl).toBe(`http://127.0.0.1:${port}/viewer`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('retains only the latest state while an SSE client has backpressure', async () => {
    let current = snapshot(1);
    const server = await start(() => current);
    const response = await fetch(`${baseUrl(server)}/stream`);
    const reader = response.body!.getReader();
    const read = sseReader(reader);
    expect(await read()).toEqual(current);
    current = { ...snapshot(2), players: [{ index: 0, name: 'x'.repeat(512 * 1024), color: null, total: 1, tiles: 1, dead: false }] };
    server.publish();
    current = snapshot(3);
    server.publish();
    current = snapshot(4);
    server.publish();
    expect(await read()).toMatchObject({ turn: 2 });
    expect(await read()).toEqual(current);
    await reader.cancel();
  });

  it('releases the HTTP listener and permits a later start', async () => {
    const server = await start();
    const oldUrl = server.viewerUrl;
    await server.start();
    expect(server.viewerUrl).toBe(oldUrl);
    await server.stop();
    await server.stop();
    await expect(fetch(oldUrl)).rejects.toThrow();
    await server.start();
    expect((await fetch(`${baseUrl(server)}/api/state`)).status).toBe(200);
  });
});

function httpStatus(url: string, headers: Record<string, string>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function sseReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<unknown> {
  const decoder = new TextDecoder();
  let pending = '';
  return async () => {
    while (!pending.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Viewer stream ended before a state frame');
      pending += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = pending.indexOf('\n\n');
    const frame = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return JSON.parse(frame.slice('data: '.length));
  };
}
