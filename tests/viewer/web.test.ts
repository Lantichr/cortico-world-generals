import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeneralsViewerSnapshot } from '../../src/viewer/contracts.ts';

const jsdomModule = 'jsdom';
const { JSDOM } = await import(jsdomModule);
const html = readFileSync(new URL('../../src/viewer/web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/viewer/web/app.js', import.meta.url), 'utf8');
const windows: any[] = [];

afterEach(() => windows.splice(0).forEach((window) => window.close()));

function snapshot(): GeneralsViewerSnapshot {
  return {
    phase: 'playing', connected: true, control: 'autonomous', paused: false, turn: 12, playerIndex: 0,
    board: { width: 4, height: 2, tiles: Array.from({ length: 8 }, (_, index) => ({
      index, x: index % 4, y: Math.floor(index / 4), terrain: 0, visible: true,
      owner: 0, armies: index + 10, general: index === 0, city: index === 6, tunnelLimit: 0,
    })) },
    players: [
      { index: 0, name: 'Player A', color: 1, total: 120, tiles: 8, dead: false },
      { index: 1, name: 'Player B', color: 0, total: 80, tiles: 6, dead: false },
    ],
    selected: null, queuedMoves: [], plan: null,
  };
}

async function mount() {
  let resolveFetch!: (value: unknown) => void;
  const initial = new Promise((resolve) => { resolveFetch = resolve; });
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:19001/viewer', runScripts: 'outside-only' });
  const { window } = dom;
  windows.push(window);
  let stream!: any;
  window.EventSource = class {
    onmessage: any;
    onopen: any;
    onerror: any;
    closed = false;
    constructor(readonly url: string) { stream = this; }
    close() { this.closed = true; }
  };
  window.fetch = async () => ({ ok: true, json: async () => initial });
  window.eval(app);
  const doc = window.document;
  return {
    window, doc, stream,
    frame: (value: GeneralsViewerSnapshot) => stream.onmessage({ data: JSON.stringify(value) }),
    initial: async (value: GeneralsViewerSnapshot) => { resolveFetch(value); await new Promise((resolve) => setTimeout(resolve, 0)); },
    tile: (index: number) => doc.querySelector(`.tile[data-index="${index}"]`),
    click: (id: string) => doc.getElementById(id).click(),
  };
}

describe('Generals viewer browser', () => {
  it('renders the player palette and terrain while hiding fog armies, owners and landmarks', async () => {
    const viewer = await mount();
    const state = snapshot();
    Object.assign(state.board!.tiles[2], { terrain: -4, visible: false, owner: 1, armies: 9876, city: true, general: true });
    Object.assign(state.board!.tiles[3], { terrain: -2, owner: null, armies: null, city: false, general: false });
    Object.assign(state.board!.tiles[4], { terrain: -3, visible: false, armies: 7654 });
    Object.assign(state.board!.tiles[5], { terrain: 1, owner: 1 });
    viewer.frame(state);
    expect(viewer.doc.querySelectorAll('.tile')).toHaveLength(8);
    expect(viewer.tile(0).style.backgroundColor).toBe('rgb(39, 146, 255)');
    expect(viewer.tile(5).style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(viewer.tile(0).querySelector('use').getAttribute('href')).toBe('#terrain-crown');
    expect(viewer.tile(6).querySelector('use').getAttribute('href')).toBe('#terrain-city');
    expect(viewer.tile(3).classList.contains('mountain')).toBe(true);
    expect(viewer.tile(2).classList.contains('fog')).toBe(true);
    expect(viewer.tile(2).style.backgroundColor).toBe('');
    expect(viewer.tile(2).querySelector('use').getAttribute('href')).toBe('#terrain-obstacle');
    expect(viewer.tile(2).textContent).toBe('');
    expect(viewer.tile(2).getAttribute('aria-label')).not.toMatch(/9876|王城|城市/);
    expect(viewer.tile(4).querySelector('use')).toBeNull();
    expect(viewer.doc.getElementById('board').textContent).not.toMatch(/9876|7654/);
  });

  it('places the local white cursor and clears its half label when the next snapshot resets it', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.selected = { index: 1, half: true };
    viewer.frame(state);
    expect(viewer.tile(1).classList.contains('selected')).toBe(true);
    expect(viewer.tile(1).querySelector('.tile-number').textContent).toBe('50%');
    state.selected = { index: 6, half: false };
    viewer.frame(state);
    expect(viewer.tile(1).classList.contains('selected')).toBe(false);
    expect(viewer.tile(1).querySelector('.tile-number').textContent).toBe('11');
    expect(viewer.tile(6).classList.contains('selected')).toBe(true);
    expect(viewer.tile(6).querySelector('.tile-number').textContent).toBe('16');
    state.selected = null;
    viewer.frame(state);
    expect(viewer.doc.querySelector('.tile.selected')).toBeNull();
  });

  it('draws each submitted edge at its source, merges directions and removes acknowledged arrows', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.queuedMoves = [
      { from: 1, to: 2, half: false, attackIndex: 10 },
      { from: 1, to: 5, half: false, attackIndex: 11 },
      { from: 6, to: 5, half: true, attackIndex: 12 },
      { from: 1, to: 2, half: false, attackIndex: 13 },
    ];
    viewer.frame(state);
    expect(viewer.tile(1).querySelector('.queued.right').textContent).toBe('→');
    expect(viewer.tile(1).querySelector('.queued.down').textContent).toBe('↓');
    expect(viewer.tile(6).querySelector('.queued.left').textContent).toBe('←');
    expect(viewer.doc.querySelectorAll('.tile-arrow.queued')).toHaveLength(3);
    state.queuedMoves = state.queuedMoves.slice(2, 3);
    viewer.frame(state);
    expect(viewer.doc.querySelectorAll('.tile-arrow.queued')).toHaveLength(1);
    expect(viewer.tile(1).querySelector('.tile-arrow')).toBeNull();
  });

  it('keeps independent planning routes separate and hides unverified tails', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.plan = { routes: [{ path: [0, 1], half: false }, { path: [5, 6, 7], half: false }], nextStepOnly: false };
    viewer.frame(state);
    expect(viewer.doc.querySelectorAll('.tile-arrow.plan')).toHaveLength(3);
    expect(viewer.tile(1).querySelector('.tile-arrow')).toBeNull();
    expect(viewer.tile(5).querySelector('.plan.right')).not.toBeNull();
    state.plan.nextStepOnly = true;
    viewer.frame(state);
    expect(viewer.doc.querySelectorAll('.tile-arrow.plan')).toHaveLength(2);
    expect(viewer.tile(6).querySelector('.tile-arrow')).toBeNull();
    expect(viewer.doc.getElementById('plan-status').textContent).toContain('仅画首步');
  });

  it('does not invent an edge when consecutive path indices cross a row boundary', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.plan = { routes: [{ path: [2, 3, 4, 5], half: false }], nextStepOnly: false };
    viewer.frame(state);
    expect(viewer.tile(2).querySelector('.plan.right')).not.toBeNull();
    expect(viewer.tile(3).querySelector('.tile-arrow')).toBeNull();
    expect(viewer.tile(4).querySelector('.plan.right')).not.toBeNull();
  });

  it('changes display controls without removing submitted moves or issuing game requests', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.queuedMoves = [{ from: 0, to: 1, half: false, attackIndex: 0 }];
    state.plan = { routes: [{ path: [0, 1, 2], half: false }], nextStepOnly: false };
    viewer.frame(state);
    viewer.click('show-plan');
    expect(viewer.doc.querySelector('.tile-arrow.plan')).toBeNull();
    expect(viewer.doc.querySelectorAll('.tile-arrow.queued')).toHaveLength(1);
    viewer.click('show-plan');
    expect(viewer.doc.querySelectorAll('.tile-arrow.plan')).toHaveLength(2);
    const board = viewer.doc.getElementById('board');
    const initialSize = board.style.getPropertyValue('--cell-size');
    viewer.click('zoom-in');
    expect(parseInt(board.style.getPropertyValue('--cell-size'))).toBeGreaterThan(parseInt(initialSize));
    viewer.click('fit-board');
    expect(board.style.getPropertyValue('--cell-size')).toBe(initialSize);
    viewer.click('board-only');
    expect(viewer.doc.body.classList.contains('board-only')).toBe(true);
    viewer.click('board-only');
    expect(viewer.doc.body.classList.contains('board-only')).toBe(false);
  });

  it('keeps a newer SSE frame when the initial state request finishes later', async () => {
    const viewer = await mount();
    const streamed = snapshot();
    streamed.turn = 30;
    viewer.frame(streamed);
    await viewer.initial(snapshot());
    expect(viewer.doc.getElementById('turn').textContent).toBe('Turn 30');
    viewer.window.dispatchEvent(new viewer.window.Event('pagehide'));
    expect(viewer.stream.closed).toBe(true);
  });

  it('shows initial state, pause and result, then removes the board and routes on reset', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.paused = true;
    state.selected = { index: 5, half: false };
    state.queuedMoves = [{ from: 1, to: 5, half: false, attackIndex: 1 }];
    await viewer.initial(state);
    expect(viewer.doc.getElementById('game-status').textContent).toContain('已暂停');
    state.phase = 'won';
    state.paused = false;
    state.selected = null;
    state.queuedMoves = [];
    viewer.frame(state);
    expect(viewer.doc.getElementById('game-status').textContent).toBe('胜利');
    expect(viewer.doc.querySelector('.selected')).toBeNull();
    expect(viewer.doc.querySelector('.tile-arrow')).toBeNull();
    state.phase = 'lobby';
    state.board = null;
    state.turn = null;
    state.players = [];
    viewer.frame(state);
    expect(viewer.doc.getElementById('board').hidden).toBe(true);
    expect(viewer.doc.querySelector('.tile')).toBeNull();
    expect(viewer.doc.querySelector('#score-rows tr')).toBeNull();
    expect(viewer.doc.getElementById('empty-board').hidden).toBe(false);
    expect(viewer.doc.getElementById('turn').textContent).toBe('Turn —');
  });

  it('marks a disconnected stream while retaining the last frame and restores live status on reconnect', async () => {
    const viewer = await mount();
    viewer.frame(snapshot());
    viewer.stream.onerror();
    expect(viewer.doc.getElementById('connection-warning').hidden).toBe(false);
    expect(viewer.doc.getElementById('turn').textContent).toBe('Turn 12');
    viewer.stream.onopen();
    expect(viewer.doc.getElementById('connection-warning').hidden).toBe(true);
    expect(viewer.doc.getElementById('connection-status').textContent).toBe('实时');
    const disconnected = snapshot();
    disconnected.connected = false;
    viewer.frame(disconnected);
    expect(viewer.doc.getElementById('connection-status').textContent).toBe('游戏未连接');
  });

  it('renders untrusted player names as text and sorts the score table', async () => {
    const viewer = await mount();
    const state = snapshot();
    state.players[1].name = '<img src=x onerror=alert(1)>';
    state.players[1].total = 200;
    viewer.frame(state);
    const rows = viewer.doc.querySelectorAll('#score-rows tr');
    expect(rows[0].querySelector('.player-name').textContent).toBe(state.players[1].name);
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[1].classList.contains('self')).toBe(true);
  });
});
