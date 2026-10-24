Owner: [`src/definition.ts`](src/definition.ts)、[`src/config.ts`](src/config.ts) 与 [`src/proxy.ts`](src/proxy.ts)。

# cortico-world-generals

[English](README.md)

连接 generals.io Bot Server 的 [Cortico](https://github.com/Pal-AI-Lab/Cortico) World，提供地图观测、手动移动工具、本机观战画面，以及可选的规则与有限搜索代理 S1。模型可以作为 S2，通过结构化意图向 S1 指定战略目标。

此候选版面向 **World API 6**，开发依赖为 Cortico SDK 0.2.3；manifest、构造与自描述也已通过 Cortico 0.2.6 的检查。原版宿主可使用手动工具、观战与自主 S1；[操作者暂停联动](docs/host-compatibility.md)为可选能力。玩家通过 `bot.generals.io` 加入 Bot Server 房间。

## 运行条件

- 支持 World API 6 的 Cortico 宿主，Node.js 22.15 或更新版本。
- Bot Server 的私有账号标识，且可连接 `botws.generals.io`。
- 使用 S1 时，房间为常规或 City-State 的 1v1 / FFA，无正式组队。

World id 为 `generals`，宿主不能包含同 id 的内建注册，仅设 `enabled=false` 无法解除冲突。使用 World API 5 的宿主需先升级到 API 6 再安装本包。迁移步骤见[兼容说明](docs/host-compatibility.md)；保留 `worlds.generals` 配置、部署 `.env` 与 Memory。

## 安装

发布后，在 Cortico 的扩展页面安装 `cortico-world-generals@next`。也可以在 **Cortico 宿主的扩展目录**运行（默认 `extensions/`，设置了 `CORTICO_EXTENSIONS_DIR` 时使用该路径）：

```sh
corepack pnpm add --ignore-workspace cortico-world-generals@next
```

尚未发布时，克隆本仓库并运行 `pnpm install`，再在宿主扩展安装器中选择该目录。安装后重启宿主进程。

## 第一局

1. 在部署的 `.env` 中填写稳定、私有的账号标识：

   ```dotenv
   CORTICO_GENERALS_USER_ID=replace-with-your-private-account-id
   ```

   已有账号沿用原标识。持有此值即可访问账号，不要提交到 GitHub。

2. 在部署的 `config.json` 启用 World：

   ```json
   { "worlds": { "generals": { "enabled": true } } }
   ```

3. 重启宿主，调用 `generals_observe` 核对连接。账号尚无用户名时，用 `generals_set_username` 注册一次唯一的 `[Bot]` 开头名称。服务端 `error_set_username` 回复为空字符串才确认成功，对应事件为 `generals.account`。

4. 手动对局调用 `generals_join_private({"room":"your-room"})`。`join-requested` 只表示已请求，`phase=lobby` 才确认入房。真人打开 `https://bot.generals.io/games/your-room`，调用 `generals_set_force_start({"enabled":true})` 投开始票。开局后读取地图，用 `generals_attack`、`generals_move_path` 或 `generals_queue_moves` 提交相邻移动。

5. 自主对局调用 `generals_start_agent({"room":"your-room","forceStart":true})`。S1 会请求入房，确认后投开始票；无需模型持续回复即可继续游戏。S2 可用 `generals_strategy_brief` 读取摘要，再用 `generals_set_intent` 指定目标；完整替换、版本号和约束规则见[工具契约](docs/contracts.md#control-and-strategic-intents)。

6. 在 Generals World 页面打开 **对局画面**。结束后先 `generals_leave`，再加入下一局；S1 需要重新委托。

上面的示例是工具名及参数对象，宿主向 Persona 提供这些工具，没有单独的游戏命令行。

## 观战与配置

画面只监听 `127.0.0.1`，显示当前视野、配色、兵力、本地白框、已发送箭头和 S1 规划。白框跟随最近提交的目的格，Bot API 不提供真人客户端的选中状态。箭头收到处理序号后消失，不代表移动或战斗成功。

`viewer.port=0` 自动分配端口，同一宿主进程内重启 World 会复用该端口；整个宿主重启后可能换址。需要 OBS 长期复用网址时，为 `worlds.generals.viewer.port` 指定空闲固定端口。配置变化重启 World 生效；当前网址以 World 页面链接为准。

配置默认值、OBS 和恢复步骤见[操作说明](docs/operations.md)。

## 能力边界

- 默认 `manual`，自主游戏需显式调用 `generals_start_agent`。S1 支持已确认的常规与 City-State 的 1v1 / FFA；正式组队、不支持的规则、队友转移或隧道会停止自主控制。
- 未接入可选暂停联动时，宿主全局暂停不会停止 S1。用 `generals_stop_agent` 撤销委托并请求清队列，或停用 World。远端对局继续，已处理的移动不能撤回。
- 断线不自动重连。重启 World 不恢复房间、开始票、委托或战略意图。
- 当前事实、最后可见事实和策略估计分开记录；不会根据历史数据刷新迷雾兵力。
- 移动回执确认发送。当前已知山地相关步骤会跳过，后续步骤仍按原顺序发送，因此过滤可能使路线断开。
- S1 搜索和只读模拟有预算与假设，不能保证守住王城或获胜。

## 文档

- [操作与配置](docs/operations.md)
- [工具、观测、意图与反馈契约](docs/contracts.md)
- [引擎与 S1 架构](docs/architecture.md)
- [宿主兼容](docs/host-compatibility.md)
- [机制来源与研究参考](docs/references.md)
- [发布检查与流程](docs/releasing.md)
- [独立 LLM 评测](docs/llm-evaluation.md)
- [可选直播解说示例](examples/streaming-commentary.md)

默认[环境提示词](src/ENV_PROMPT.md)说明机制与工具用途，不规定人格，也不要求解说。bot 包或部署的 `worlds/generals/ENV_PROMPT.md` 可覆盖模板，见[操作说明](docs/operations.md#environment-prompt)。

## 开发

开发环境使用 Node.js 24.15+ 或 22.22.2+，以支持指定的 pnpm 版本。

```sh
corepack pnpm install
pnpm test
pnpm typecheck
pnpm check:package
pnpm check:host-patch
```

测试使用本地 WebSocket/HTTP 服务、真实引擎子进程和确定性离线裁判，不需要账号，不启动真实 bot，也不连接外部网络。裁判对手为脚本规则，对其结果不能等同于真人实力。

npm 包直接包含 TypeScript 源码与本机画面资源。`0.1.0-rc.2` 使用 `next` 发布标签，本地检查不执行发布。

## 许可

[MIT](LICENSE)。这是独立的 generals.io 集成，游戏名称与远端服务归各自权利人所有。
