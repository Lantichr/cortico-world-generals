Owner: `scripts/eval-llm.ts`

# 独立 LLM 评测

套件用本地裁判、现有 S1 和直接连接模型端点的 S2 运行固定局面及完整对局，无需 Cortico 部署、游戏账号或真人。它从源码仓运行；npm 包不包含 `scripts/`、`tests/` 和评测命令所需的裁判。

在仓库根目录安装开发依赖后执行 `pnpm eval:llm`。每次使用一个新的输出目录，结果放在 `scratch/` 下；已有 `events.jsonl` 的目录会被拒绝，防止混入另一轮结果。

## 先运行脚本模型

将以下配置保存为 `scratch/llm-smoke.json`：

```json
{
  "mode": "scripted",
  "suite": "all",
  "timing": "realtime",
  "tickMs": 0,
  "maxTurns": 1200,
  "snapshotTurns": 12,
  "repetitions": 1
}
```

```powershell
pnpm eval:llm --config scratch/llm-smoke.json --out scratch/llm-smoke-01
```

`scripted` 使用只读取己方摘要的固定规则 S2，验证工具调用、意图校验和日志链路，不访问模型服务。`tickMs: 0` 让本地对局尽快运行，循环仍会让出执行权。它不能测量 LLM 的决策质量或实际网络延迟。

## 连接模型端点

配置独立于 Cortico 部署，不读取部署配置或密钥。将以下配置保存为 `scratch/llm-live.json`，替换端点及模型名：

```json
{
  "mode": "llm",
  "suite": "snapshots",
  "timing": "realtime",
  "tickMs": 500,
  "maxTurns": 1200,
  "snapshotTurns": 12,
  "reportIntervalTurns": 20,
  "minReportTurns": 4,
  "requestTimeoutMs": 120000,
  "maxModelCalls": 16,
  "maxToolRounds": 6,
  "maxToolCalls": 24,
  "maxContextChars": 120000,
  "repetitions": 1,
  "model": {
    "baseUrl": "https://endpoint.example/v1",
    "protocol": "chat_completions",
    "model": "configured-model",
    "apiKeyEnv": "CORTICO_GENERALS_EVAL_API_KEY",
    "reasoningEffort": "low",
    "maxTokensParameter": "max_tokens",
    "maxOutputTokens": 8192
  }
}
```

```powershell
$env:CORTICO_GENERALS_EVAL_API_KEY = 'your-api-key'
pnpm eval:llm --config scratch/llm-live.json --out scratch/llm-live-01
```

`baseUrl` 是 API 根地址。`protocol` 支持 `chat_completions`、`responses` 和 `gemini_interactions`，适配器分别追加 `/chat/completions`、`/responses` 和 `/interactions`。端点及模型须支持所选协议。公网地址须用 HTTPS；本机回环地址允许 HTTP。地址不得包含账号密码、查询参数或片段。

`model` 指定端点接受的模型名。`apiKeyEnv` 只保存环境变量名，值从当前进程环境读取；Chat Completions 和 Responses 使用 Bearer 凭据，Gemini 使用 `x-goog-api-key`。无需认证的本机服务可省略该字段。配置不接受直接写入 API key。

`reasoningEffort` 按协议写入 Chat Completions 的 `reasoning_effort`、Responses 的 `reasoning.effort` 或 Gemini 的 `generation_config.thinking_level`。值原样传递，适配器不根据模型名替换值。Gemini 接受协议枚举 `minimal`、`low`、`medium`、`high`，具体模型支持的子集由服务校验；Chat Completions 和 Responses 的可用值也取决于端点。未配置可选思考项时不发送相应字段。

`maxOutputTokens` 限制每次响应的输出预算。Chat Completions 通过 `maxTokensParameter` 选择 `max_tokens`（默认）或 `max_completion_tokens`；Responses 使用 `max_output_tokens`，Gemini 使用 `generation_config.max_output_tokens`。各家对思考 token 的计数不同，见下表。截断或未完成的响应记为模型错误，不执行其中的工具调用。

Chat Completions 工具续轮保留 `reasoning_content`。Responses 保留原始输出条目，Gemini 保留原始 `steps` 及其中的思考签名，供后续工具请求回传。工具最终参数由正式 `IntentController` 校验；Responses 的工具 schema 使用 `strict: false`。协议格式参考[官方工具调用文档](https://developers.openai.com/api/docs/guides/function-calling)。

## 模型配置模板

三个模板默认运行六个固定局面，先验证接口和意图行为。运行完整成对对局时，将 `suite` 改为 `games` 或使用 `--suite games`；运行两者用 `all`。模板使用 `low` 思考强度、16384 输出预算和 120 秒单次请求超时，模型调用期间完整对局仍继续运行。

| 模板 | 协议及模型 | 输出预算 |
| --- | --- | --- |
| [`llm-suite-deepseek.json`](../examples/llm-suite-deepseek.json) | DeepSeek 原厂 Chat Completions，`deepseek-flash` | `max_tokens`，包含思考和正文 |
| [`llm-suite-gemini.json`](../examples/llm-suite-gemini.json) | Google Interactions，`gemini-3.8-flash` | `generation_config.max_output_tokens`，包含思考和正文 |
| [`llm-suite-qwen.json`](../examples/llm-suite-qwen.json) | 百炼 Chat Completions，`qwen3.8-flash` | `max_completion_tokens`，包含思考和正文 |

例如运行 DeepSeek 模板：

```powershell
$env:CORTICO_GENERALS_EVAL_DEEPSEEK_API_KEY = 'your-api-key'
pnpm eval:llm --config examples/llm-suite-deepseek.json --out scratch/llm-deepseek-01
```

另外两个模板分别读取 `CORTICO_GENERALS_EVAL_GEMINI_API_KEY` 和 `CORTICO_GENERALS_EVAL_QWEN_API_KEY`。

DeepSeek 原厂的 [`deepseek-flash` 当前指向 DeepSeek-V4.1-Flash-1017](https://api-docs.deepseek.com/quick_start/pricing/)。`thinking: "enabled"` 或 `"disabled"` 发送为原厂 `thinking.type`；`reasoningEffort` 支持 `none`、`low`、`high`、`max`，其中 `none` 禁用思考。官网还接受 `minimal` 映射到 `low`，`medium`、`xhigh` 映射到 `high`。原厂与托管服务的模型名和思考开关可能不同：百炼的 DeepSeek 使用 `enable_thinking`，不能直接照搬原厂模板。参数及工具续轮要求见 [Chat API](https://api-docs.deepseek.com/api/create-chat-completion/) 和[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

Qwen 模板使用中国北京地域的兼容地址；国际新加坡地址是 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。API key 必须与服务地域匹配。两者仍可用；已有 Workspace 专属地址可直接替换 `baseUrl`。`enableThinking`、`thinkingBudget`、`preserveThinking` 分别写入顶层 `enable_thinking`、`thinking_budget`、`preserve_thinking`。配置文件使用这些字段时无需包在 `extra_body` 中。

Qwen3.8-Flash 的思考强度为 `low`、`medium`、`xhigh`；服务将 `minimal` 映射到 `low`，`high`、`max` 映射到 `xhigh`，`none` 关闭思考。`reasoningEffort` 与 `thinkingBudget` 不能同时设置。`thinkingBudget` 只限制思考 token；`max_completion_tokens` 限制思考与正文总和。Qwen 的旧 `max_tokens` 只限制正文，不能用作总输出上限。模板启用 `preserveThinking`，工具续轮通过独立的 `reasoning_content` 字段回传历史思考。详见百炼 [Chat 参数参考](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)和[思考模式](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)。

Gemini3.8-Flash 模板使用原生 Interactions API。`reasoningEffort` 设置 `generation_config.thinking_level`，`maxOutputTokens` 设置 `generation_config.max_output_tokens`；无需设置 Chat Completions 专用的 `maxTokensParameter`。请求使用 `store: false`，由本地保留完整 `steps`、工具调用及思考签名。服务将正文和思考用量分别报告为 `total_output_tokens`、`total_thought_tokens`，评测汇总的 `outputTokens` 取两者之和。参数及续轮格式见 [Interactions API](https://ai.google.dev/api/interactions-api)、[思考配置](https://ai.google.dev/gemini-api/docs/thinking)和[工具调用](https://ai.google.dev/gemini-api/docs/function-calling)。

模板不证明账号拥有对应模型权限，也未执行真实服务调用。更换托管服务时，应同时核对 API 协议、模型名、思考选项和输出 token 字段。

CLI 可用 `--mode scripted|llm`、`--suite all|snapshots|games` 覆盖配置，`--help` 显示用法。真实模型推荐使用 `realtime` 和 `tickMs: 500`，让请求耗时表现为游戏内经过的 turn；`paused` 会在每轮 S2 对话期间暂停裁判，适合单独检查决策，不用于评价实时表现。

## 局面与对照

每个场景、每次重复都成对运行 `s1` 和所选 S2 模式，使用相同地图、己方编号、对手及 S1 搜索预算。完整对局的 `s1` 变体从自主状态开始。固定局面可预置旧意图，两种变体均继承该意图，以检查 S2 是否需要调整它。

| 固定局面 | 检查内容 |
| --- | --- |
| `dispersed-advantage` | 优势兵力分散时的集结选择 |
| `converging-fronts` | 多名敌军接近王城时的防守选择 |
| `changed-roster` | 已有玩家淘汰后的目标选择及己方编号核对 |
| `held-rally` | 预置集结意图及驻军约束，检查是否解除保留兵力 |
| `changing-frontier` | 预置前线集结意图；首个模型回复到达前由裁判执行一次敌方进攻，检查工具按当前事实拒绝失守目标 |
| `distant-garrisons` | 区分远处敌将驻军与实际逼近的兵力 |

六个固定局面均等待一轮 S2 工具对话完成，随后运行最多 `snapshotTurns` 个本地 turn，胜负或己方淘汰提前结束。`changing-frontier` 的指定敌方进攻在等待期间发生。局面结果记为 `snapshot`，不计胜负。

完整对局有四组：双人标准、双人 City-State、三人标准及四人 City-State，己方编号分别为 0、1、2、3。所有其他玩家使用只读取自身视野的 `pusher` 对手。达到 `maxTurns` 仍未结束时记为 `unfinished`，不计作平局或失败。`repetitions` 可重复同一组成对实验；模型输出仍可能变化。

`referenceChoiceMatch` 仅诊断模型是否提交过参考动作类别，或是否触发指定的事实校验；它不是策略正确率。合理的不改动、替代目标或先查询新事实，可能与参考类别不同。`distant-garrisons` 未设置参考类别，结果为 `null`。参考类别及对手的全知状态不会作为模型输入；预置意图通过摘要与状态工具正常可见。

## S2 上下文及预算

每局有独立的 S1、意图账本和对局标识。每轮 S2 对话以系统提示和最新压缩摘要重新开始，不累计前几轮对话；工具回合可按需读取完整意图、地图、格子历史或当前可见兵力排名。系统提示复用 World 的战略意图、机制及策略段落。模型没有账号、房间或直接移动工具。

首次 S1 决策前，摘要的 `currentTask` 与 `estimates` 为 `null`；已有决策保留其依据 turn。

实时模式下 S1 和对手在模型思考时继续行动，目标每 turn 间隔为 `tickMs`；S1 计算超时会延长实际间隔。纯 S1 对照无需等待模型，按相同 turn 和搜索预算快速运行。同一玩家最多一轮 S2 对话在运行，不堆积旧报告。常规报告间隔由 `reportIntervalTurns` 控制，重要状态变化最早在 `minReportTurns` 后触发下一轮。公开分数变化相对于上一次实际交付的摘要计算。

`requestTimeoutMs` 限制一次模型请求；`maxModelCalls` 限制单个案例的模型请求总数，包括工具后续请求。`maxToolRounds` 和 `maxToolCalls` 分别限制一轮 S2 对话的请求轮数及工具调用数，`maxContextChars` 限制下一次请求前序列化消息的字符数。耗尽预算或请求失败后，S1 继续行动；已有意图按原有完成、失效和到期规则处理。已完成目标的硬约束仍保留至清除或到期。

模型提交的 `gameId`、`controlEpoch`、`revision`、`basedOnTurn` 和 `expiresTurn` 原样交给正式校验器，不因回复延迟自动改写。拒绝新意图会保留旧有效意图。一个基于旧 turn 的意图是否可用，由应用时的当前事实、修订号和期限共同决定。

## 结果文件

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 版本、工作树修改标记、源码哈希、配置、完整提示及其哈希、裁判和对手说明 |
| `events.jsonl` | 报告、请求和回复、工具参数及回执、每次本地动作和终局结果 |
| `summary.json` | 成对结果、胜负及未结束计数、调用成本和行为指标 |

模型请求和工具记录包含观测 turn、应用 turn；成功回复另记耗时和经过的 turn。汇总包含模型调用数、错误和超时、端点返回的输入/输出 tokens、意图接受与拒绝数、S1 移动与等待数、非法及受同 turn 竞争影响的动作数、最终兵力和城市数。脚本模型 tokens 为零；真实服务未返回的 usage 按零记录，不能据此计算准确账单。

`case_start` 和 `arena_applied` 在 JSONL 中归档裁判的全知地图，供复盘核对；模型请求只收到己方摘要及其主动查询的遮雾观察。全知归档不进入模型上下文。本地执行记录名为 `arena_applied`，不宣称收到线上服务器的处理确认。

当前验证覆盖脚本模型和无公网 HTTP 适配器测试，尚无真实 LLM 对局结果。比较模型前应保留配置、版本及提示哈希，多次成对运行，并结合动作日志审查意图对实际行为的影响。

## 裁判范围

本地裁判覆盖局部视野、标准 2/50 turn 产兵、城市、玩家淘汰及兵力继承，并轮转每 turn 的行动先后顺序。它未实现官方依赖解析、网络动作队列或 AFK 判定。固定地图和规则对手也不能证明真人对战强度。

`pnpm test` 不访问真实模型服务；实际 API 调用只由评测 CLI 显式发起。
