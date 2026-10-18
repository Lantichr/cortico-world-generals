import type { WorldDefinition } from 'cortico/world.ts';
import { GENERALS_DEFAULTS, GENERALS_SECRET, type GeneralsConfigSection } from './config.ts';
import { GeneralsWorldProxy } from './proxy.ts';

export const GENERALS: WorldDefinition<GeneralsConfigSection> = {
  id: 'generals', label: 'Generals',
  defaults: () => ({ ...GENERALS_DEFAULTS, agent: { ...GENERALS_DEFAULTS.agent }, viewer: { ...GENERALS_DEFAULTS.viewer } }),
  create: (ctx) => new GeneralsWorldProxy(ctx.cfg, ctx.secret(GENERALS_SECRET), ctx.timezone),
};
