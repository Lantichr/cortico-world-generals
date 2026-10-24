import type { StrategyBrief } from '../../src/agent/report.ts';
import type { ModelClient } from './provider.ts';

/** Observation-only fallback for exercising the harness; its rules are not an LLM strength baseline. */
export function createScriptedModel(): ModelClient {
  return { async complete(messages) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    if (messages.at(-1)?.role === 'tool') return { message: { role: 'assistant', content: '本轮判断结束。' }, usage };
    const brief = JSON.parse([...messages].reverse().find((message) => message.role === 'user')!.content!) as StrategyBrief;
    const anchor = { gameId: brief.gameId, controlEpoch: brief.controlEpoch, revision: brief.intent.lastRevision + 1 };
    let name = 'generals_set_intent';
    let args: Record<string, unknown>;
    if (brief.intent.active?.goal.kind === 'gather' && brief.intent.active.reserves > 0) {
      name = 'generals_clear_intent'; args = anchor;
    } else {
      const home = brief.facts.home, main = brief.facts.ownForces[0], target = brief.facts.enemyGenerals[0];
      const nearby = home ? brief.facts.enemyForces.filter((force) => Math.abs(force.x - home.x) + Math.abs(force.y - home.y) <= 4)
        .reduce((sum, force) => sum + force.armies!, 0) : 0;
      const goal = home && ((brief.estimates?.homeDefense?.gapArmies ?? 0) > 0 || nearby > home.armies!)
        ? { kind: 'defend', target: { x: home.x, y: home.y } }
        : brief.intent.active?.goal.kind === 'gather' ? brief.intent.active.goal
          : target && main && main.armies! > (target.currentArmies ?? Infinity) + 10
            ? { kind: 'attack_general', player: target.player }
            : main && brief.facts.ownForces.length >= 3 && main.armies! >= 30
              ? { kind: 'gather', target: { x: main.x, y: main.y } } : { kind: 'expand' };
      args = { ...anchor, basedOnTurn: brief.turn, expiresTurn: brief.turn! + 80, goal, constraints: {} };
    }
    return { message: { role: 'assistant', tool_calls: [{ id: `script-${anchor.revision}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }, usage };
  } };
}
