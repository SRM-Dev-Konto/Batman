const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const LAN_IP = '172.20.10.2';
const INDEX_HTML = path.join(__dirname, 'index.html');

const COLS = 48;
const ROWS = 28;
const TICK_MS = 125;
const BASE_LENGTH = 3;
const MUSHROOM_COUNT = 6;
const AVATARS = ['🦇', '🦊', '🐯', '🐺', '🦁', '🐻', '🐲', '🐼', '🐨', '🤖', '👾', '🦄'];

const rooms = new Map();

function rid() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function uid() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function key(p) {
  return `${p.x},${p.y}`;
}

function same(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function inBounds(p) {
  return p.x >= 0 && p.x < COLS && p.y >= 0 && p.y < ROWS;
}

function legalDir(current, next) {
  return !(current.x + next.x === 0 && current.y + next.y === 0);
}

function normalizeName(input) {
  const letters = Array.from(String(input || '').trim())
    .filter((ch) => /\p{L}/u.test(ch))
    .slice(0, 5);

  if (letters.length !== 5) return null;
  return letters.join('');
}

function snakeColor(index) {
  const palette = ['#7CFF6B', '#ffb84d', '#ff6b9a', '#8f8dff', '#52d6ff', '#ffdf5a', '#ff7d6b', '#b46bff'];
  return palette[index % palette.length];
}

function createSnake(id, name, color, body, dir, avatar, ai = false) {
  return {
    id,
    name,
    color,
    body,
    dir,
    pendingDir: clone(dir),
    score: 0,
    avatar,
    ai,
    baseLength: BASE_LENGTH,
  };
}

function roomRandomCell() {
  return { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
}

function blockedSet(room, options = {}) {
  const blocked = new Set();
  const ignoreSnakeIds = new Set(options.ignoreSnakeIds || []);

  room.snakes.forEach((snake) => {
    if (ignoreSnakeIds.has(snake.id)) return;
    snake.body.forEach((seg) => blocked.add(key(seg)));
  });

  if (!options.ignoreFood && room.food) blocked.add(key(room.food));
  if (!options.ignoreTunnel && room.tunnel) {
    blocked.add(key(room.tunnel.entry));
    blocked.add(key(room.tunnel.exit));
  }
  if (!options.ignoreMushrooms) room.mushrooms.forEach((m) => blocked.add(key(m)));

  if (options.extraCells) {
    options.extraCells.forEach((p) => blocked.add(key(p)));
  }

  return blocked;
}

function pickEmptyCell(room, options = {}) {
  const blocked = blockedSet(room, options);

  for (let i = 0; i < 4000; i++) {
    const p = roomRandomCell();
    if (!blocked.has(key(p))) return p;
  }

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const p = { x, y };
      if (!blocked.has(key(p))) return p;
    }
  }

  return { x: 0, y: 0 };
}

function pickAvatar(room) {
  const used = new Set(room.snakes.map((s) => s.avatar).filter(Boolean));
  const pool = AVATARS.filter((a) => !used.has(a));
  const choices = pool.length ? pool : AVATARS;
  return choices[Math.floor(Math.random() * choices.length)];
}

function tunnelAt(room, cell) {
  if (!room.tunnel) return null;
  if (same(room.tunnel.entry, cell)) return room.tunnel.exit;
  if (same(room.tunnel.exit, cell)) return room.tunnel.entry;
  return null;
}

function mushroomAt(room, cell) {
  return room.mushrooms.findIndex((m) => same(m, cell));
}

function spawnTunnel(room) {
  let entry = pickEmptyCell(room, { ignoreFood: true, ignoreTunnel: true, ignoreMushrooms: true });
  let exit = pickEmptyCell(room, {
    ignoreFood: true,
    ignoreTunnel: true,
    ignoreMushrooms: true,
    extraCells: [entry],
  });

  let tries = 0;
  while (Math.abs(entry.x - exit.x) + Math.abs(entry.y - exit.y) < 10 && tries < 100) {
    exit = pickEmptyCell(room, {
      ignoreFood: true,
      ignoreTunnel: true,
      ignoreMushrooms: true,
      extraCells: [entry],
    });
    tries += 1;
  }

  room.tunnel = { entry, exit };
}

function spawnMushrooms(room) {
  room.mushrooms = [];
  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    const mushroom = pickEmptyCell(room, {
      ignoreFood: true,
      ignoreTunnel: false,
      ignoreMushrooms: true,
    });
    room.mushrooms.push(mushroom);
  }
}

function spawnFood(room) {
  room.food = pickEmptyCell(room, {
    ignoreFood: true,
    ignoreTunnel: false,
    ignoreMushrooms: false,
  });
}

function spawnPoliceCar(room) {
  room.policeCar = {
    x: -4,
    y: Math.floor(Math.random() * ROWS),
    width: 4,
    speed: 1,
    flash: 0,
  };
}

function policeCells(police) {
  if (!police) return [];
  const cells = [];
  for (let i = 0; i < police.width; i++) {
    const cell = { x: police.x + i, y: police.y };
    if (inBounds(cell)) cells.push(cell);
  }
  return cells;
}

function touchesPolice(room, snake, head) {
  if (!room.policeCar) return false;
  return policeCells(room.policeCar).some(
    (cell) => same(cell, head) || snake.body.some((seg) => same(seg, cell))
  );
}

function updatePolice(room) {
  if (!room.policeCar) {
    room.policeCooldown -= 1;
    if (room.policeCooldown <= 0) spawnPoliceCar(room);
    return;
  }

  room.policeCar.x += room.policeCar.speed;
  room.policeCar.flash = (room.policeCar.flash + 1) % 8;

  if (room.policeCar.x > COLS + 2) {
    room.policeCar = null;
    room.policeCooldown = 10 + Math.floor(Math.random() * 42);
  }
}

function createRoom(roomId = rid()) {
  const room = {
    id: roomId,
    clients: new Map(),
    snakes: [],
    food: { x: 0, y: 0 },
    mushrooms: [],
    tunnel: null,
    policeCar: null,
    policeCooldown: 12 + Math.floor(Math.random() * 36),
  };

  const aiSnake = createSnake(
    'AI',
    'AI',
    '#6bb7ff',
    [
      { x: 24, y: 14 },
      { x: 23, y: 14 },
      { x: 22, y: 14 },
    ],
    { x: 1, y: 0 },
    '🤖',
    true,
  );
  room.snakes.push(aiSnake);

  spawnTunnel(room);
  spawnMushrooms(room);
  spawnFood(room);

  rooms.set(room.id, room);
  return room;
}

function ensureRoom(roomId) {
  const id = (roomId || '').toString().toUpperCase();
  if (id && rooms.has(id)) return rooms.get(id);
  return createRoom(id || rid());
}

function createPlayerSnake(room, playerName) {
  const snake = createSnake(
    uid(),
    playerName,
    snakeColor(room.snakes.filter((s) => !s.ai).length + 1),
    [
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 },
    ],
    { x: 1, y: 0 },
    pickAvatar(room),
    false,
  );

  room.snakes.push(snake);
  respawnSnake(room, snake, true);
  return snake;
}

function buildBodyFromHead(head, dir, length) {
  const body = [{ x: head.x, y: head.y }];
  for (let i = 1; i < length; i++) {
    body.push({ x: head.x - dir.x * i, y: head.y - dir.y * i });
  }
  return body;
}

function bodyFits(room, body, snakeId) {
  const blocked = blockedSet(room, {
    ignoreSnakeIds: [snakeId],
    ignoreFood: true,
    ignoreTunnel: true,
    ignoreMushrooms: true,
  });

  return body.every((seg) => inBounds(seg) && !blocked.has(key(seg)));
}

function respawnSnake(room, snake, preserveLength = true) {
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];

  const length = preserveLength ? Math.max(BASE_LENGTH, snake.body.length || BASE_LENGTH) : BASE_LENGTH;

  for (let attempt = 0; attempt < 600; attempt++) {
    const head = pickEmptyCell(room, {
      ignoreSnakeIds: [snake.id],
      ignoreFood: true,
      ignoreTunnel: true,
      ignoreMushrooms: true,
    });

    const candidates = dirs.filter((dir) => bodyFits(room, buildBodyFromHead(head, dir, length), snake.id));
    if (!candidates.length) continue;

    const dir = candidates[Math.floor(Math.random() * candidates.length)];
    const body = buildBodyFromHead(head, dir, length);
    if (!bodyFits(room, body, snake.id)) continue;

    snake.body = body;
    snake.dir = clone(dir);
    snake.pendingDir = clone(dir);
    return true;
  }

  snake.body = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ];
  snake.dir = { x: 1, y: 0 };
  snake.pendingDir = { x: 1, y: 0 };
  return false;
}

function shrinkSnake(room, snake) {
  const length = snake.baseLength || BASE_LENGTH;
  const head = snake.body[0];
  const body = buildBodyFromHead(head, snake.dir, length);
  if (body && bodyFits(room, body, snake.id)) {
    snake.body = body;
    return true;
  }
  return respawnSnake(room, snake, false);
}

function neighborsFor(room, cell, blocked) {
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];

  const out = [];
  for (const d of dirs) {
    const next = { x: cell.x + d.x, y: cell.y + d.y };
    if (!inBounds(next)) continue;
    if (blocked.has(key(next))) continue;
    out.push(next);
  }

  const jump = tunnelAt(room, cell);
  if (jump && !blocked.has(key(jump))) out.push(clone(jump));

  return out;
}

function bfsToFood(room, start, blocked) {
  const queue = [start];
  const prev = new Map();
  const seen = new Set([key(start)]);

  while (queue.length) {
    const cur = queue.shift();
    if (same(cur, room.food)) {
      const path = [cur];
      let k = key(cur);
      while (prev.has(k)) {
        const p = prev.get(k);
        path.push(p);
        k = key(p);
      }
      path.reverse();
      return path;
    }

    for (const next of neighborsFor(room, cur, blocked)) {
      const nk = key(next);
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, cur);
      queue.push(next);
    }
  }

  return null;
}

function chooseAIDir(room, snake) {
  const head = snake.body[0];
  const blocked = blockedSet(room, {
    ignoreSnakeIds: [snake.id],
    ignoreFood: true,
    ignoreTunnel: true,
    ignoreMushrooms: true,
  });

  const path = bfsToFood(room, head, blocked);
  if (path && path.length > 1) {
    const next = path[1];
    const dir = { x: next.x - head.x, y: next.y - head.y };
    if (legalDir(snake.dir, dir)) return dir;
  }

  const candidates = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ].filter((dir) => legalDir(snake.dir, dir));

  let best = snake.dir;
  let bestScore = -Infinity;

  for (const dir of candidates) {
    const next = { x: head.x + dir.x, y: head.y + dir.y };
    if (!inBounds(next)) continue;

    const jump = tunnelAt(room, next);
    const landed = jump ? clone(jump) : next;
    if (blocked.has(key(landed))) continue;

    const dist = Math.abs(landed.x - room.food.x) + Math.abs(landed.y - room.food.y);
    const score = 150 - dist * 6 + Math.random() * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }

  return best;
}

function removeMushroom(room, index) {
  if (index < 0) return;
  room.mushrooms.splice(index, 1);
  room.mushrooms.push(pickEmptyCell(room, {
    ignoreFood: false,
    ignoreTunnel: false,
    ignoreMushrooms: false,
  }));
}

function tickRoom(room) {
  if (!room.snakes.length) return;

  updatePolice(room);

  const moves = new Map();

  room.snakes.forEach((snake) => {
    if (snake.ai) {
      snake.pendingDir = chooseAIDir(room, snake);
    }

    if (legalDir(snake.dir, snake.pendingDir)) {
      snake.dir = clone(snake.pendingDir);
    }

    let head = {
      x: snake.body[0].x + snake.dir.x,
      y: snake.body[0].y + snake.dir.y,
    };

    const jump = tunnelAt(room, head);
    if (jump) head = clone(jump);

    moves.set(snake.id, {
      snake,
      head,
      grow: same(head, room.food),
      shrink: mushroomAt(room, head) >= 0,
    });
  });

  const occupied = new Map();
  room.snakes.forEach((snake) => {
    const move = moves.get(snake.id);
    snake.body.forEach((seg, idx) => {
      if (idx === snake.body.length - 1 && !move.grow) return;
      occupied.set(key(seg), snake.id);
    });
  });

  const headMap = new Map();
  moves.forEach((move, id) => {
    const k = key(move.head);
    if (!headMap.has(k)) headMap.set(k, []);
    headMap.get(k).push(id);
  });

  const respawnIds = new Set();

  moves.forEach((move, id) => {
    const { snake, head } = move;

    if (!inBounds(head)) {
      respawnIds.add(id);
      return;
    }

    const hitOtherBody = occupied.has(key(head)) && occupied.get(key(head)) !== id;
    const hitSelf = snake.body.slice(0, snake.body.length - (move.grow ? 0 : 1)).some((seg) => same(seg, head));
    const hitPolice = touchesPolice(room, snake, head);

    if (hitOtherBody || hitSelf || hitPolice) respawnIds.add(id);
  });

  headMap.forEach((ids) => {
    if (ids.length > 1) ids.forEach((id) => respawnIds.add(id));
  });

  room.snakes.forEach((snake) => {
    if (respawnIds.has(snake.id)) return;

    const move = moves.get(snake.id);
    snake.body.unshift(move.head);
    if (!move.grow) snake.body.pop();

    if (move.grow) {
      snake.score += 1;
      spawnFood(room);
    }

    if (move.shrink) {
      const idx = mushroomAt(room, move.head);
      removeMushroom(room, idx);
      shrinkSnake(room, snake);
    }
  });

  respawnIds.forEach((id) => {
    const snake = room.snakes.find((s) => s.id === id);
    if (snake) respawnSnake(room, snake, false);
  });

  if (room.snakes.some((s) => same(s.body[0], room.food))) {
    spawnFood(room);
  }
}

function broadcast(room) {
  const payload = JSON.stringify({
    type: 'state',
    roomId: room.id,
    cols: COLS,
    rows: ROWS,
    food: room.food,
    tunnel: room.tunnel,
    mushrooms: room.mushrooms,
    policeCar: room.policeCar,
    snakes: room.snakes.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      body: s.body,
      score: s.score,
      avatar: s.avatar,
      ai: s.ai,
    })),
  });

  room.clients.forEach((_meta, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      baseUrl: `http://${LAN_IP}:${PORT}`,
      roomHint: 'Enter your 5-letter name to join the game.',
      cols: COLS,
      rows: ROWS,
    }));
    return;
  }

  if (parsed.pathname === '/api/new-room') {
    const room = createRoom();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ roomId: room.id }));
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const parsed = url.parse(req.url || '/', true);
  const requestedRoomId = (parsed.query.room || '').toString().toUpperCase();
  const rawName = parsed.query.name;
  const playerName = normalizeName(rawName);

  if (!playerName) {
    ws.send(JSON.stringify({ type: 'error', message: 'Name must be exactly 5 letters.' }));
    ws.close(1008, 'invalid name');
    return;
  }

  const room = ensureRoom(requestedRoomId);
  const snake = createPlayerSnake(room, playerName);
  room.clients.set(ws, { snakeId: snake.id, playerName });

  ws.send(JSON.stringify({
    type: 'hello',
    roomId: room.id,
    snakeId: snake.id,
    playerName,
  }));

  broadcast(room);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const meta = room.clients.get(ws);
      if (!meta) return;

      const activeSnake = room.snakes.find((s) => s.id === meta.snakeId);
      if (!activeSnake) return;

      if (msg.type === 'dir' && msg.dir && typeof msg.dir.x === 'number' && typeof msg.dir.y === 'number') {
        const nextDir = { x: msg.dir.x, y: msg.dir.y };
        if (legalDir(activeSnake.dir, nextDir)) {
          activeSnake.pendingDir = nextDir;
        }
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on('close', () => {
    const meta = room.clients.get(ws);
    if (meta) {
      const index = room.snakes.findIndex((s) => s.id === meta.snakeId);
      if (index >= 0) room.snakes.splice(index, 1);
      room.clients.delete(ws);
    }

    if (!room.clients.size && !room.snakes.length) {
      rooms.delete(room.id);
      return;
    }

    broadcast(room);
  });
});

setInterval(() => {
  rooms.forEach((room) => {
    tickRoom(room);
    broadcast(room);
  });
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================');
  console.log('TEAM BATMAN');
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${LAN_IP}:${PORT}`);
  console.log('====================================');
});
