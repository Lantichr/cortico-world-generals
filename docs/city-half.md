Owner: [`src/agent/city-half.ts`](../src/agent/city-half.ts), [`src/agent/python-channel.ts`](../src/agent/python-channel.ts), [`src/agent/city-half/`](../src/agent/city-half/), [`src/config.ts`](../src/config.ts) and [`compat/migrate-city-half.mjs`](../compat/migrate-city-half.mjs).

# city-half-1 backend

Select `worlds.generals.agent.backend="city-half-1"` and restart the World. Existing
configurations keep `legacy`. Python 3.10 or later must be available to the host process;
`pythonExecutable` accepts a command name or full executable path, with no shell arguments.
No pip packages are needed. Tools, account configuration and one-game delegation stay the same.

```json
{
  "worlds": {
    "generals": {
      "enabled": true,
      "agent": {
        "backend": "city-half-1",
        "pythonExecutable": "python",
        "pythonTimeoutMs": 5000
      }
    }
  }
}
```

`generals_start_agent` starts delegation; it does not register an account. Once playing,
`generals_agent_status` reports `backend=city-half-1`, `method=harris_city_half` and an
`execution` object on the last decision. `generals_strategy_brief` includes execution mode,
phase, main-force position and allocated tile count, dated by the decision turn. The viewer
shows the sent next step and local cursor. Python import or startup failure appears as an S1
error on the first observation; manual observation and the viewer remain usable.

S2 uses the same seven goals and full-replacement intent contract as legacy. `reserves` and
`avoidTiles` remain hard constraints, including during emergency defense. Preferences are
heuristics. A task may report blocked, preempted or completed while autonomous actions
continue under the retained constraints. Arbitrary exact transfers, parallel force commands
and prescribed routes are outside this interface. The fixed backend search limits are
documented in its [source contract](../src/agent/city-half/README.md);
`decisionBudgetMs` and `maxSearchNodes` apply only to legacy. `pythonTimeoutMs` is a process
request deadline, including initialization; it does not tune search quality. A reply based on
an older map or intent is discarded. Slow computation can therefore skip moves.

Stop, pause notifications, result, disconnect and a new game terminate the Python instance.
Restarting delegation creates a fresh instance. Exceptions, malformed replies and timeouts
revoke autonomous control and request queue clearing; no backend switch occurs. Without the
optional host pause integration, global pause still leaves S1 running. Use `generals_stop_agent`
or disable the World when that integration is absent.

Supported: standard and City-State 1v1/FFA, rectangular maps, basic land, cities, generals,
mountains and fog. The existing S1 rule gate rejects custom-map metadata, other modifiers,
chess clocks, city regeneration, deserts, swamps, teams and tunnels. Special terrain below
`-4` is also rejected. Undeclared server mechanisms cannot be inferred from missing metadata.
This release does not add support for the special modes reviewed separately.

## Configuration migration

Old configuration files load through defaults without a rewrite. To record the defaults or
select the new backend explicitly, use the migration shipped in the package directory:

```sh
node compat/migrate-city-half.mjs /path/to/config.json --city-half-1
node compat/migrate-city-half.mjs /path/to/config.json --city-half-1 --write
```

The first command is a dry run. `--write` creates a sibling `.bak` and atomically replaces
the config. Other settings and account identifiers are retained. Omit `--city-half-1` to
fill missing fields while preserving the selected backend.

## 中文

在部署配置中设置 `worlds.generals.agent.backend="city-half-1"`，重启 World 后使用原有
`generals_start_agent` 委托。宿主进程需要能运行 Python 3.10+；Windows 可将
`pythonExecutable` 写成 `C:\\Python312\\python.exe` 这样的完整路径。无需安装 pip 依赖。
旧配置默认保留 legacy，不会自动切换策略。

S2 仍使用七种结构化目标；摘要新增后端、执行模式、阶段、主力位置和分配格数。
紧急防守可抢占任务，但不能静默违反留守和禁行约束。进程出错或超时会停止 S1 并报告错误。
搜索预算配置只影响 legacy；`pythonTimeoutMs` 是请求超时，不是搜索强度。停止、换局、断线和
宿主提供的暂停通知都会结束当前 Python 实例。未接入暂停联动时，全局暂停仍不会停止 S1。

本次仅接入既有 city-half-1 策略，支持常规及 City-State 的 1v1/FFA 和基础地形。
不会新增特殊模式支持。上面的迁移默认 dry-run；加 `--write` 后先备份再原子替换，保留其他配置。
