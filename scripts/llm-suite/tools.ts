import type { AgentObservation, AgentReport, AgentTile } from '../../src/agent/contracts.ts';
import { resolvePlayerLifecycles } from '../../src/agent/lifecycle.ts';
import type { StrategyBrief } from '../../src/agent/report.ts';
import { IntentController, STRATEGY_ANCHOR_PROPERTIES, STRATEGY_INTENT_PROPERTIES } from '../../src/intent.ts';
import { GENERALS_TILE_SCHEMA, parseTiles } from '../../src/moves.ts';
import { GENERALS_ARMY_LIMITS } from '../../src/state.ts';
import type { Tool } from './provider.ts';

export interface SuiteToolsContext {
  observation: () => AgentObservation;
  status: () => AgentReport;
  brief: () => StrategyBrief;
  intents: IntentController;
}

function declaration(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): Tool {
  return { type: 'function', function: { name: `generals_${name}`, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

function fields(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('unknown_tool_argument');
}

function compactCell(tile: AgentTile, observation: AgentObservation): string {
  if (!tile.visible) {
    const fog = tile.terrain === -4 ? 'X' : '?';
    const seen = observation.history[tile.index];
    if (!seen) return fog;
    const features = seen.terrain === -2 ? '#' : `${seen.general ? 'G' : ''}${seen.city ? 'C' : ''}${seen.tunnelLimit ? 'T' : ''}` || '.';
    return `${fog}~${features}`;
  }
  if (tile.terrain === -2) return '#';
  const tunnel = tile.tunnelLimit ? `T${tile.tunnelLimit === -1 ? '?' : tile.tunnelLimit}` : '';
  return `${tile.owner === null ? '.' : `p${tile.owner}`}:${tile.armies}${tile.general ? 'G' : ''}${tile.city ? 'C' : ''}${tunnel}`;
}

function observe(observation: AgentObservation, brief: StrategyBrief, compact: boolean): unknown {
  const general = observation.tiles[observation.generals[observation.playerIndex]];
  const selfScore = observation.scores.find((score) => score !== null && typeof score === 'object'
    && (score as Record<string, unknown>).i === observation.playerIndex) ?? null;
  const base = { gameId: observation.gameId, controlEpoch: observation.controlEpoch, playerIndex: observation.playerIndex,
    turn: observation.turn, width: observation.width, height: observation.height, selfScore,
    selfGeneral: general?.visible ? general : null, enemyGenerals: brief.facts.enemyGenerals,
    playerLifecycle: resolvePlayerLifecycles(observation), scores: observation.scores };
  if (!compact) return { ...base, format: 'raw',
    armies: observation.tiles.map((tile) => tile.visible ? tile.armies : null),
    terrain: observation.tiles.map((tile) => tile.terrain),
    tunnelLimits: observation.tiles.map((tile) => tile.visible ? tile.tunnelLimit : null),
    selfTiles: observation.tiles.filter((tile) => tile.visible && tile.owner === observation.playerIndex)
      .map(({ index, x, y, armies }) => ({ index, x, y, armies })),
    cities: observation.tiles.filter((tile) => tile.visible && tile.city).map((tile) => tile.index),
    generals: observation.generals };
  const header = `y\\x ${Array.from({ length: observation.width }, (_, x) => x).join(' ')}`;
  const cells = observation.tiles.map((tile) => compactCell(tile, observation));
  const rows = Array.from({ length: observation.height }, (_, y) => `${y} ${cells.slice(y * observation.width, (y + 1) * observation.width).join(' ')}`);
  return { ...base, format: 'compact', grid: [header, ...rows].join('\n'),
    playerLegend: resolvePlayerLifecycles(observation).map(({ player }) => `p${player} ${player === observation.playerIndex ? 'self' : 'enemy'}`).join('\n') };
}

/** The arena supplies only this player's view. Mutations use the production intent boundary at execution time. */
export function createTools(context: SuiteToolsContext): { declarations: Tool[]; execute(name: string, args: Record<string, unknown>): unknown } {
  const declarations = [
    declaration('strategy_brief', 'Read the compressed strategic report with current intent anchors, public scores, visible forces, dated general sightings and conditional S1 estimates. Read agent_status before replacing hard constraints.'),
    declaration('agent_status', 'Read S1 control, the complete active intent and revision ledger, current decision and intent feedback. Local arena actions are logged separately; they are not server processing confirmations.'),
    declaration('observe', 'Read this player\'s masked map and public scores. raw includes map arrays and selfTiles; compact returns a coordinate grid. Fog markers with ~ show historical features only. Use inspect_tiles for dated history. No hidden armies are inferred.', {
      format: { type: 'string', enum: ['raw', 'compact'], default: 'raw' },
    }),
    declaration('inspect_tiles', 'Read selected current tiles and separate lastSeen facts. lastSeenTurn dates historical ownership, armies and features; null means never seen. Historical armies do not establish current armies.', {
      tiles: { type: 'array', minItems: 1, items: GENERALS_TILE_SCHEMA },
    }, ['tiles']),
    declaration('list_armies', 'Rank currently visible owned stacks by armies, then row-major position. Defaults to the top 10 self tiles. all returns self, enemy, allies and unknown groups; this arena is free-for-all. Excludes neutral and fog tiles, including historical armies. Compare visible enemy stacks with public scores; garrisons may be needed for defense.', {
      side: { type: 'string', enum: ['self', 'enemy', 'all'], default: 'self' },
      limit: { type: 'integer', minimum: 1, maximum: GENERALS_ARMY_LIMITS.max, default: GENERALS_ARMY_LIMITS.default },
    }),
    declaration('set_intent', 'Give S1 a strategic goal and hard constraints. Copy gameId/controlEpoch and observed turn from a report; revision must exceed intent.lastRevision and expiresTurn is exclusive. Current facts are checked when applied. Rejections preserve the active intent; completion retains constraints until clear or expiry. S1 continues during model replies.',
      STRATEGY_INTENT_PROPERTIES, ['gameId', 'controlEpoch', 'revision', 'basedOnTurn', 'expiresTurn', 'goal', 'constraints']),
    declaration('clear_intent', 'Clear the strategic goal and all hard constraints while S1 continues autonomous play. Copy current gameId/controlEpoch and use a revision greater than intent.lastRevision. A delayed clear cannot remove a newer intent.',
      STRATEGY_ANCHOR_PROPERTIES, ['gameId', 'controlEpoch', 'revision']),
  ];
  const execute = (name: string, args: Record<string, unknown>): unknown => {
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool_arguments_must_be_object');
      const observation = context.observation();
      let result: unknown;
      switch (name) {
        case 'generals_strategy_brief': fields(args, []); result = context.brief(); break;
        case 'generals_agent_status': fields(args, []); result = context.status(); break;
        case 'generals_observe':
          fields(args, ['format']);
          if (args.format !== undefined && args.format !== 'raw' && args.format !== 'compact') throw new Error('format must be raw or compact');
          result = observe(observation, context.brief(), args.format === 'compact'); break;
        case 'generals_inspect_tiles':
          fields(args, ['tiles']);
          result = { playerIndex: observation.playerIndex, observedTurn: observation.turn,
            tiles: parseTiles(args.tiles, observation.width, observation.height)
              .map((index) => ({ current: observation.tiles[index], lastSeen: observation.history[index] })) }; break;
        case 'generals_list_armies': {
          fields(args, ['side', 'limit']);
          const side = args.side === undefined ? 'self' : args.side;
          const limit = args.limit === undefined ? GENERALS_ARMY_LIMITS.default : args.limit;
          if (side !== 'self' && side !== 'enemy' && side !== 'all') throw new Error('side must be self, enemy or all');
          if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > GENERALS_ARMY_LIMITS.max) {
            throw new Error(`limit must be an integer from 1 to ${GENERALS_ARMY_LIMITS.max}`);
          }
          const ranked = observation.tiles.filter((tile) => tile.visible && tile.owner !== null && tile.armies !== null && tile.armies > 0)
            .sort((a, b) => b.armies! - a.armies! || a.index - b.index);
          const stacks = (self: boolean) => ranked.filter((tile) => (tile.owner === observation.playerIndex) === self).slice(0, limit)
            .map(({ x, y, owner, armies, general, city }) => ({ x, y, owner, armies, general: general === true, city: city === true }));
          const groups = side === 'all' ? { self: stacks(true), enemy: stacks(false), allies: [], unknown: [] }
            : side === 'self' ? { self: stacks(true) } : { enemy: stacks(false) };
          result = { playerIndex: observation.playerIndex, observedTurn: observation.turn, side, limit, groups }; break;
        }
        case 'generals_set_intent':
        case 'generals_clear_intent': {
          const status = context.status();
          if (status.phase !== 'playing' || status.control !== 'autonomous') throw new Error('intent_requires_autonomous_game');
          if (name === 'generals_set_intent') context.intents.submit(args, observation);
          else context.intents.clear(args, observation);
          result = context.brief(); break;
        }
        default: throw new Error(`unknown_tool:${name}`);
      }
      return structuredClone(result);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { declarations, execute };
}
