(() => {
  const colors = ['#ff0000', '#2792ff', '#008000', '#008080', '#fa8c01', '#f032e6', '#800080', '#9b0101', '#b3ac32', '#9a5e24', '#1031ff', '#594ca5', '#85a91c', '#ff6668', '#b47fca', '#b49971'];
  const directions = { right: '→', left: '←', up: '↑', down: '↓' };
  const phases = { offline: '离线', connecting: '连接中', connected: '等待入房', 'join-requested': '入房中', lobby: '等待开局', playing: '对局中', won: '胜利', lost: '败北', disconnected: '游戏连接断开' };
  const board = document.getElementById('board');
  const viewport = document.getElementById('board-viewport');
  const showPlan = document.getElementById('show-plan');
  const warning = document.getElementById('connection-warning');
  const connection = document.getElementById('connection-status');
  const cells = [];
  let current = null;
  let dimensions = '';
  let zoom = 1;
  let receivedStream = false;
  let streamConnected = false;

  function connectionStatus() {
    const disconnected = !streamConnected || current && !current.connected;
    connection.textContent = !streamConnected ? '画面重连中' : current && !current.connected ? '游戏未连接' : '实时';
    connection.classList.toggle('disconnected', disconnected);
    warning.hidden = streamConnected;
  }

  function fitBoard() {
    if (!current || !current.board) return;
    const { width, height } = current.board;
    const padding = document.body.classList.contains('board-only') ? 12 : 32;
    const availableWidth = viewport.clientWidth - padding;
    const availableHeight = viewport.clientHeight - padding;
    const fit = Math.min(availableWidth / width, availableHeight / height);
    const cellSize = Math.max(8, Math.min(80, Math.floor((fit > 0 ? fit : 32) * zoom)));
    board.style.setProperty('--cell-size', `${cellSize}px`);
  }

  function ensureBoard(width, height) {
    const nextDimensions = `${width}x${height}`;
    if (dimensions === nextDimensions) return;
    dimensions = nextDimensions;
    cells.length = 0;
    board.replaceChildren();
    board.style.gridTemplateColumns = `repeat(${width}, var(--cell-size))`;
    board.setAttribute('aria-rowcount', String(height));
    board.setAttribute('aria-colcount', String(width));
    for (let index = 0; index < width * height; index++) {
      const cell = document.createElement('div');
      cell.className = 'tile';
      cell.dataset.index = String(index);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-rowindex', String(Math.floor(index / width) + 1));
      cell.setAttribute('aria-colindex', String(index % width + 1));
      cells.push(cell);
      board.append(cell);
    }
  }

  function terrainIcon(kind) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'terrain');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#terrain-${kind}`);
    icon.append(use);
    return icon;
  }

  function direction(from, to, width) {
    if (Math.floor(from / width) === Math.floor(to / width)) {
      if (to === from + 1) return 'right';
      if (to === from - 1) return 'left';
    }
    if (to === from + width) return 'down';
    if (to === from - width) return 'up';
    return null;
  }

  function drawArrows(moves, kind, width) {
    for (const { from, to } of moves) {
      const cell = cells[from];
      const side = direction(from, to, width);
      if (!cell || !cells[to] || !side || cell.querySelector(`.tile-arrow.${kind}.${side}`)) continue;
      const arrow = document.createElement('span');
      arrow.className = `tile-arrow ${kind} ${side}`;
      arrow.textContent = directions[side];
      arrow.dataset.to = String(to);
      arrow.setAttribute('aria-hidden', 'true');
      cell.append(arrow);
    }
  }

  function renderBoard(snapshot) {
    const map = snapshot.board;
    board.hidden = !map;
    document.getElementById('empty-board').hidden = !!map;
    if (!map) {
      board.replaceChildren();
      dimensions = '';
      cells.length = 0;
      return;
    }
    ensureBoard(map.width, map.height);
    const playerColors = new Map(snapshot.players.map((player) => [player.index, colors[player.color] || '#808080']));
    for (const tile of map.tiles) {
      const cell = cells[tile.index];
      const fog = !tile.visible;
      cell.replaceChildren();
      cell.className = 'tile';
      cell.style.removeProperty('background-color');
      let terrain = null;
      if (fog) {
        cell.classList.add('fog');
        if (tile.terrain === -4) terrain = 'obstacle';
      } else if (tile.terrain === -2) {
        cell.classList.add('mountain');
        terrain = 'mountain';
      } else {
        if (tile.owner !== null) cell.style.backgroundColor = playerColors.get(tile.owner) || '#808080';
        else if (tile.city || tile.general || tile.armies) cell.classList.add('neutral');
        terrain = tile.general ? 'crown' : tile.city ? 'city' : tile.tunnelLimit ? 'tunnel' : null;
      }
      if (terrain) cell.append(terrainIcon(terrain));
      const selected = snapshot.selected && snapshot.selected.index === tile.index;
      if (selected) cell.classList.add('selected');
      const number = document.createElement('span');
      number.className = 'tile-number';
      number.textContent = fog ? '' : selected && snapshot.selected.half ? '50%' : tile.armies || tile.city ? String(tile.armies ?? '') : '';
      cell.append(number);
      const label = fog ? tile.terrain === -4 ? '迷雾障碍' : '迷雾' : tile.terrain === -2 ? '山地' : `${tile.general ? '王城 ' : tile.city ? '城市 ' : ''}${tile.armies ?? 0} 兵`;
      cell.setAttribute('aria-label', `${tile.x},${tile.y} ${label}${selected ? '，选中' : ''}`);
    }
    if (showPlan.checked && snapshot.plan) {
      const plannedMoves = [];
      for (const route of snapshot.plan.routes) {
        const end = snapshot.plan.nextStepOnly ? Math.min(route.path.length, 2) : route.path.length;
        for (let step = 1; step < end; step++) plannedMoves.push({ from: route.path[step - 1], to: route.path[step] });
      }
      drawArrows(plannedMoves, 'plan', map.width);
    }
    drawArrows(snapshot.queuedMoves, 'queued', map.width);
    fitBoard();
  }

  function renderPlayers(snapshot) {
    const rows = document.getElementById('score-rows');
    rows.replaceChildren();
    const players = snapshot.players.slice().sort((a, b) => Number(a.dead) - Number(b.dead) || (b.total ?? -1) - (a.total ?? -1) || a.index - b.index);
    for (const player of players) {
      const row = document.createElement('tr');
      row.classList.toggle('self', player.index === snapshot.playerIndex);
      row.classList.toggle('dead', player.dead);
      const name = document.createElement('td');
      name.className = 'player-name';
      const swatch = document.createElement('span');
      swatch.className = 'player-color';
      swatch.style.backgroundColor = colors[player.color] || '#808080';
      const text = document.createElement('span');
      text.textContent = player.name;
      name.append(swatch, text);
      const armies = document.createElement('td');
      armies.textContent = player.total === null ? '—' : String(player.total);
      const land = document.createElement('td');
      land.textContent = player.tiles === null ? '—' : String(player.tiles);
      row.append(name, armies, land);
      rows.append(row);
    }
  }

  function render(snapshot) {
    current = snapshot;
    document.getElementById('turn').textContent = `Turn ${snapshot.turn ?? '—'}`;
    document.getElementById('game-status').textContent = `${phases[snapshot.phase] || snapshot.phase}${snapshot.paused ? ' · 已暂停' : ''}${snapshot.phase === 'playing' ? snapshot.control === 'autonomous' ? ' · S1' : ' · 手动' : ''}`;
    document.getElementById('plan-status').textContent = showPlan.checked && snapshot.plan && snapshot.plan.nextStepOnly ? '后续路线待核对，仅画首步' : '';
    renderBoard(snapshot);
    renderPlayers(snapshot);
    connectionStatus();
  }

  showPlan.addEventListener('change', () => { if (current) render(current); });
  document.getElementById('board-only').addEventListener('change', (event) => {
    document.body.classList.toggle('board-only', event.target.checked);
    fitBoard();
  });
  document.getElementById('zoom-in').addEventListener('click', () => { zoom = Math.min(4, zoom * 1.2); fitBoard(); });
  document.getElementById('zoom-out').addEventListener('click', () => { zoom = Math.max(.25, zoom / 1.2); fitBoard(); });
  document.getElementById('fit-board').addEventListener('click', () => { zoom = 1; fitBoard(); });
  window.addEventListener('resize', fitBoard);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitBoard).observe(viewport);

  const stream = new EventSource('/stream');
  stream.onopen = () => { streamConnected = true; connectionStatus(); };
  stream.onerror = () => { streamConnected = false; connectionStatus(); };
  stream.onmessage = (event) => {
    receivedStream = true;
    streamConnected = true;
    render(JSON.parse(event.data));
  };
  fetch('/api/state', { cache: 'no-store' })
    .then((response) => { if (!response.ok) throw new Error('state unavailable'); return response.json(); })
    .then((snapshot) => { if (!receivedStream) render(snapshot); })
    .catch(() => { if (!receivedStream) connectionStatus(); });
  window.addEventListener('pagehide', () => stream.close());
})();
