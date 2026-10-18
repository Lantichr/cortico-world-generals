Owner: `src/`, `tests/`, `scripts/check-package.ts` and `.github/workflows/`.

# Contributing

Contributors must understand and be able to explain all submitted code, including code written
with a coding agent. Describe the problem and resulting behavior in plain language, with at
least one paragraph in Chinese and one in English in pull requests.

Keep platform behavior in this World. Do not access Persona Memory. Prefer semantic instructions
for model judgment; reserve control flow for protocol, legality and timing checks. Keep observed
facts separate from estimates and identify heuristic fallbacks.

Use the existing World, tool, event and configuration names. Configuration belongs under
`worlds.generals`; durations include their unit. Comments explain contracts or non-obvious facts.
Remove repeated prose, vague claims and accounts of how a change was negotiated.

Run `pnpm test`, `pnpm typecheck`, `pnpm check:package` and `pnpm check:host-patch` before committing. Tests use local
protocol servers and real engine processes; they must not connect to generals.io or start a bot.
Package checks require the `tar` command, provided by Linux, macOS and current Windows systems.
Stage explicit paths. Use Conventional Commits; do not push or publish as part of a local fix.

Changes to configuration keys or stored content ship with a migration that defaults to dry-run,
backs up the original and replaces files atomically. Preserve existing account identifiers and
deployment overrides. Never include account credentials or deployment data in reports or patches.

Contributions are licensed under MIT. Retain required third-party notices. See
[Cortico's contribution rules](https://github.com/Pal-AI-Lab/Cortico/blob/main/CONTRIBUTING.md)
for contributions to the host framework.

## 中文

提交者需要理解并能解释全部提交代码，包括由编程代理生成的代码。PR 用中英文说明具体问题和改动后的
行为。协议、动作合法性和限时搜索由代码处理；模型判断优先使用语义指令。观测事实、估算和启发式兜底
必须可区分。World 不访问 Persona 的 Memory。

提交前运行 `pnpm test`、`pnpm typecheck`、`pnpm check:package` 和 `pnpm check:host-patch`。测试仅使用本机协议服务和真实
引擎子进程，不连接 generals.io，不启动真实 bot。只暂存明确路径，提交使用 Conventional Commits。
配置或存储格式变更附带默认 dry-run、写前备份、原子替换的迁移。提交内容不包含账号凭据或部署数据。
