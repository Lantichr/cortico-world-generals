import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { GENERALS_DEFAULTS, GENERALS_SECRET, type GeneralsConfigSection } from './config.ts';
import { GeneralsWorldProxy } from './proxy.ts';
import { GeneralsWorld } from './world.ts';

const defaults = (): GeneralsConfigSection => ({
  ...GENERALS_DEFAULTS, agent: { ...GENERALS_DEFAULTS.agent }, viewer: { ...GENERALS_DEFAULTS.viewer },
});

export const GENERALS: WorldDefinition<GeneralsConfigSection> = {
  id: 'generals', label: 'Generals',
  defaults,
  create: (ctx) => new GeneralsWorldProxy(ctx.cfg, ctx.secret(GENERALS_SECRET), ctx.timezone),
  describe: {
    tools: describeTools(new GeneralsWorld(defaults(), '', 'UTC').tools(), {}),
    events: [
      { type: 'generals.connection', description: 'Connection established, disconnected, or the engine exited unexpectedly.', trigger: 'flush' },
      { type: 'generals.start', description: 'The server starts a game in the current room.', trigger: 'flush' },
      { type: 'generals.state', description: 'Map update after snapshotIntervalMs: deferred delivery in manual control, archive only in autonomous control.' },
      { type: 'generals.result', description: 'The server reports game_won or game_lost, with the final local view.', trigger: 'flush' },
      { type: 'generals.lobby', description: 'The server sends queue_update or queue_left.', trigger: 'flush' },
      { type: 'generals.account', description: 'An empty error_set_username reply confirms account name registration.', trigger: 'flush' },
      { type: 'generals.error', description: 'The server sends gio_error or an error-prefixed reply, excluding successful username registration.', trigger: 'flush' },
      { type: 'generals.chat', description: 'The server sends chat_message.', trigger: 'flush' },
      { type: 'generals.afk', description: 'The server sends afk_warning or the player score warn_afk flag changes.', trigger: 'flush' },
      { type: 'generals.agent', description: 'Archived S1 control and decision report after control changes, game updates or a forced report.' },
      { type: 'generals.action', description: 'Archived autonomous move and decision after the move is sent.' },
      { type: 'generals.feedback', description: 'Archived autonomous-move feedback when server processing is reported, relevant map facts change, confirmation times out or cancellation is requested.' },
      { type: 'generals.strategy', description: 'Deferred strategic brief after S1 delegation, on a forced or significant change, or after reportIntervalMs.', trigger: 'flush', tags: ['snapshot'] },
    ],
  },
};
