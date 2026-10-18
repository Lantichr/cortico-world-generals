export interface Move {
  from: number;
  to: number;
  half: boolean;
}

interface RouteSegment {
  firstStep: number;
  lastStep: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Original chains affected by filtering, with consecutive retained edge ranges; no execution or troop availability is inferred. */
export function describeFilteredRoutes(moves: Move[], skippedSteps: number[], width: number) {
  const skipped = new Set(skippedSteps);
  const routes: Array<{ firstStep: number; lastStep: number; retainedSegments: RouteSegment[] }> = [];
  if (!skipped.size) return routes;
  const point = (index: number) => ({ x: index % width, y: Math.floor(index / width) });
  let routeStart = 0;
  for (let end = 1; end <= moves.length; end++) {
    if (end < moves.length && moves[end - 1].to === moves[end].from) continue;
    if (moves.slice(routeStart, end).some((_, i) => skipped.has(routeStart + i + 1))) {
      const retainedSegments: RouteSegment[] = [];
      let segment: RouteSegment | undefined;
      for (let i = routeStart; i < end; i++) {
        if (skipped.has(i + 1)) { segment = undefined; continue; }
        if (segment) {
          segment.lastStep = i + 1;
          segment.to = point(moves[i].to);
        } else {
          segment = { firstStep: i + 1, lastStep: i + 1, from: point(moves[i].from), to: point(moves[i].to) };
          retainedSegments.push(segment);
        }
      }
      routes.push({ firstStep: routeStart + 1, lastStep: end, retainedSegments });
    }
    routeStart = end;
  }
  return routes;
}

export const GENERALS_TILE_SCHEMA = {
  description: '格子索引 y * width + x，或 {x, y} 坐标；左上角为 (0, 0)。',
  anyOf: [
    { type: 'integer', minimum: 0 },
    {
      type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 } },
      required: ['x', 'y'], additionalProperties: false,
    },
  ],
};

export const GENERALS_MOVE_SCHEMA = {
  type: 'object',
  properties: {
    from: GENERALS_TILE_SCHEMA, to: GENERALS_TILE_SCHEMA,
    half: { type: 'boolean', default: false, description: 'true 移动半数兵力；false 移动除驻守兵外的全部兵力。' },
  },
  required: ['from', 'to'], additionalProperties: false,
};

function tile(value: unknown, width: number, height: number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value >= width * height) throw new Error('Tile index is outside the map');
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a tile index or {x, y}');
  const { x, y } = value as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'x' && key !== 'y')) throw new Error('Tile coordinates accept only x and y; put from, to and half on the move object');
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
    || x < 0 || y < 0 || x >= width || y >= height) throw new Error('Tile coordinates are outside the map');
  return y * width + x;
}

export function parseMove(value: unknown, width: number, height: number): Move {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a move object');
  const args = value as Record<string, unknown>;
  let from: number, to: number;
  try { from = tile(args.from, width, height); }
  catch (error) { throw new Error(`from: ${String(error)}`); }
  try { to = tile(args.to, width, height); }
  catch (error) { throw new Error(`to: ${String(error)}`); }
  const distance = Math.abs(from % width - to % width) + Math.abs(Math.floor(from / width) - Math.floor(to / width));
  if (distance !== 1) throw new Error(`Tiles must share an edge: (${from % width},${Math.floor(from / width)}) -> (${to % width},${Math.floor(to / width)})`);
  if (args.half !== undefined && typeof args.half !== 'boolean') throw new Error('half must be boolean');
  return { from, to, half: args.half === true };
}

export function parseTiles(value: unknown, width: number, height: number): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('tiles must be a nonempty array');
  return value.map((point, i) => {
    try { return tile(point, width, height); }
    catch (error) { throw new Error(`tiles[${i}]: ${String(error)}`); }
  });
}

export function parseMoves(value: unknown, width: number, height: number): Move[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('moves must be a nonempty array');
  return value.map((move, i) => {
    try { return parseMove(move, width, height); }
    catch (error) { throw new Error(`moves[${i}] (step ${i + 1}): ${String(error)}`); }
  });
}

export function parsePath(value: unknown, half: unknown, width: number, height: number): Move[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error('path must contain at least two tiles');
  if (Array.isArray(half)) {
    if (half.length !== value.length - 1 || !half.every((flag) => typeof flag === 'boolean')) {
      throw new Error('half must contain one boolean per path edge');
    }
  } else if (half !== undefined && typeof half !== 'boolean') throw new Error('half must be a boolean or an array of booleans');
  const path = value.map((point, i) => {
    try { return tile(point, width, height); }
    catch (error) { throw new Error(`path[${i}]: ${String(error)}`); }
  });
  return path.slice(1).map((to, i) => {
    try { return parseMove({ from: path[i], to, half: Array.isArray(half) ? half[i] : half }, width, height); }
    catch (error) { throw new Error(`path edge ${i + 1} (path[${i}] -> path[${i + 1}]): ${String(error)}`); }
  });
}
