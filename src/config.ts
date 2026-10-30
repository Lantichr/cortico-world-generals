import type { ConfigGroup } from 'cortico/core/types.ts';

export interface GeneralsConfigSection {
  enabled: boolean;
  serverUrl: string;
  connectTimeoutMs: number;
  snapshotIntervalMs: number;
  viewer: { enabled: boolean; port: number };
  agent: {
    backend: 'legacy' | 'city-half-1';
    pythonExecutable: string;
    pythonTimeoutMs: number;
    decisionBudgetMs: number;
    maxSearchNodes: number;
    reportIntervalMs: number;
  };
}

export const GENERALS_SECRET = 'CORTICO_GENERALS_USER_ID';
export const GENERALS_DEFAULTS: GeneralsConfigSection = {
  enabled: false,
  serverUrl: 'wss://botws.generals.io/socket.io/?EIO=4&transport=websocket',
  connectTimeoutMs: 15_000,
  snapshotIntervalMs: 2000,
  viewer: { enabled: true, port: 0 },
  agent: { backend: 'legacy', pythonExecutable: 'python', pythonTimeoutMs: 5000,
    decisionBudgetMs: 50, maxSearchNodes: 4000, reportIntervalMs: 10_000 },
};

export const GENERALS_CONFIG_GROUP: ConfigGroup = {
  id: 'world:generals', owner: 'world:generals',
  schema: {
    type: 'object', title: 'Generals',
    properties: {
      'worlds.generals.serverUrl': {
        type: 'string', title: 'WebSocket 地址', 'x-hot': false,
        description: 'Engine.IO 4、Socket.IO 默认命名空间；重启 World 生效。',
      },
      'worlds.generals.connectTimeoutMs': {
        type: 'integer', title: '连接超时', minimum: 100, maximum: 120_000, 'x-hot': false,
      },
      'worlds.generals.snapshotIntervalMs': {
        type: 'integer', title: '地图事件最短间隔', minimum: 0, maximum: 60_000, 'x-hot': false,
        description: '每帧都更新观测工具；待投递的地图事件只保留最新帧。',
      },
      'worlds.generals.viewer.enabled': {
        type: 'boolean', title: '本机对局画面', 'x-hot': false,
        description: '只读显示当前视野、出兵光标和路线；重启 World 生效。',
      },
      'worlds.generals.viewer.port': {
        type: 'integer', title: '画面端口', minimum: 0, maximum: 65535, 'x-hot': false,
        description: '只监听 127.0.0.1；0 自动分配，固定端口便于 OBS 复用地址。',
      },
      'worlds.generals.agent.decisionBudgetMs': {
        type: 'integer', title: 'S1 决策预算（毫秒）', minimum: 1, maximum: 200, 'x-hot': false,
        description: '仅 legacy 后端；搜索达到预算时使用已完成候选或简化策略；重启 World 生效。',
      },
      'worlds.generals.agent.maxSearchNodes': {
        type: 'integer', title: 'S1 搜索节点上限', minimum: 1, maximum: 100_000, 'x-hot': false,
        description: '仅 legacy 后端；city-half-1 使用随版本固定的内部搜索上限。',
      },
      'worlds.generals.agent.backend': {
        type: 'string', enum: ['legacy', 'city-half-1'], title: 'S1 后端', 'x-hot': false,
        description: 'city-half-1 使用随包提供的 Harris 策略和 S2 执行层，需要 Python 3.10+；重启 World 生效。',
      },
      'worlds.generals.agent.pythonExecutable': {
        type: 'string', title: 'Python 可执行文件', 'x-hot': false,
        description: '仅 city-half-1；可填命令名或完整路径，不含命令行参数。无需 pip 依赖。',
      },
      'worlds.generals.agent.pythonTimeoutMs': {
        type: 'integer', minimum: 100, maximum: 60_000, title: 'Python 请求超时（毫秒）', 'x-hot': false,
        description: '包括初始化；超时会停止 S1 并报告错误，不会切换后端。过期帧的结果不会发送。',
      },
      'worlds.generals.agent.reportIntervalMs': {
        type: 'integer', title: 'S2 战略报告间隔（毫秒）', minimum: 1000, maximum: 60_000, 'x-hot': false,
        description: '重要状态变化提前报告；待投递报告合并为最新状态。自动模式的完整地图只归档。',
      },
    },
  },
};
