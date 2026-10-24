import { readFileSync } from 'node:fs';

/** Strategy and mechanics track the shipped World prompt; room and account control stay outside this runner. */
export function suitePrompt(): string {
  const source = readFileSync(new URL('../../src/ENV_PROMPT.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const section = (name: string) => {
    const start = source.indexOf(`## ${name}\n`);
    if (start < 0) throw new Error(`Missing World prompt section: ${name}`);
    const end = source.indexOf('\n## ', start + 3);
    return source.slice(start, end < 0 ? undefined : end);
  };
  const intent = section('S2 战略意图').split('\n\n');
  intent.splice(1, 1);
  return [
    '你是 generals 本地裁判对局的 S2，S1 已获委托并独立行动。只使用提供的工具选择战略；允许保留有效意图或不改动。每轮仅收到最新摘要，完整意图可按需查询。',
    '本套件没有账号、房间、聊天或直接移动工具。实时模式中等待回复时游戏继续；工具按执行时的当前观测校验。历史事实保留日期，策略估计不是已确认事实。工具错误需要依据新事实处理。',
    intent.join('\n\n'), section('判断局势与选择目标'), section('基础机制'),
    ...section('按需查询与事实边界').split('\n\n').filter((paragraph) => paragraph.startsWith('grid ') || paragraph.startsWith('generals_inspect_tiles ') || paragraph.startsWith('raw/compact ')),
    'generals_observe 返回己方视野内的地图及本局最后可见事实；generals_inspect_tiles 核对关键格，generals_list_armies 仅列当前可见兵力。迷雾中当前归属与兵力为 null。不能从己方迷雾推断敌方视野。',
    '摘要 facts 是标注 turn 的事实。estimates、currentTask 有独立依据时间；homeDefense 是有限搜索给出的有条件估计，partial/unavailable 不证明无解。parallel_upper_bound 是多个玩家并行进攻的保守上界。strategicGeneralPlayers 是距己方王城超过两步的可见敌将驻军，不证明其正在逼近。',
    'FFA 中 attack_general 可指定任意未淘汰对手；inactive 表示停用，eliminated 才表示淘汰。夺一人后继续本局。己方身份用 playerIndex 核对。',
  ].join('\n\n');
}
