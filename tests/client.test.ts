import { afterEach, beforeEach, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { GeneralsClient } from '../src/client.ts';

let server: WebSocketServer;
let client: GeneralsClient;
let url: string;

beforeEach(async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/?EIO=4&transport=websocket`;
});

afterEach(async () => {
  await client.stop();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('rejects a connection that never acknowledges the namespace', async () => {
  client = new GeneralsClient(() => {}, () => {});
  server.on('connection', (socket) => socket.send('0' + JSON.stringify({ pingInterval: 1000, pingTimeout: 1000 })));
  await expect(client.start(url, 50)).rejects.toThrow('Connection timed out');
  expect(client.connected).toBe(false);
});

it('ends a connected transport when server heartbeats stop', async () => {
  let disconnected: (reason: string) => void;
  const closed = new Promise<string>((resolve) => { disconnected = resolve; });
  client = new GeneralsClient(() => {}, (reason) => disconnected(reason));
  server.on('connection', (socket) => {
    socket.send('0' + JSON.stringify({ pingInterval: 20, pingTimeout: 30 }));
    socket.on('message', (raw) => { if (raw.toString() === '40') socket.send('40{"sid":"fixture"}'); });
  });
  await client.start(url, 1000);
  expect(await closed).toContain('heartbeat timed out');
  expect(client.connected).toBe(false);
  expect(() => client.send('leave_game')).toThrow('disconnected');
});

it('reports malformed packets as the disconnect cause', async () => {
  let disconnected: (reason: string) => void;
  const closed = new Promise<string>((resolve) => { disconnected = resolve; });
  client = new GeneralsClient(() => {}, (reason) => disconnected(reason));
  server.on('connection', (socket) => {
    socket.send('0' + JSON.stringify({ pingInterval: 1000, pingTimeout: 1000 }));
    socket.on('message', (raw) => {
      if (raw.toString() === '40') {
        socket.send('40{"sid":"fixture"}');
        socket.send('42{}');
      }
    });
  });
  await client.start(url, 1000);
  expect(await closed).toBe('Invalid Socket.IO event');
});
