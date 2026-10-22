Owner: [`src/definition.ts`](src/definition.ts), [`src/config.ts`](src/config.ts) and [`src/proxy.ts`](src/proxy.ts).

# cortico-world-generals

[中文](README_zh.md)

A [Cortico](https://github.com/Pal-AI-Lab/Cortico) World for the generals.io Bot Server. It provides game observations, manual movement tools, a local board viewer, and an optional S1 agent with rule-based tactics and bounded search. A model can act as S2 by giving S1 structured strategic goals.

This release candidate targets **Cortico 0.2.3, World API 6**. Manual tools, the viewer and autonomous S1 work with the unmodified host. [Operator-pause integration](docs/host-compatibility.md) is optional. The package uses the Bot Server, with human players joining at `bot.generals.io`.

## Requirements

- A Cortico host supporting World API 6, with Node.js 22.15 or later.
- A private Bot Server account identifier and network access to `botws.generals.io`.
- For S1: a standard or City-State 1v1 or free-for-all room.

The World id is `generals`. The host must not contain an in-tree registration with the same id; setting that World's `enabled=false` does not remove the registration. Hosts using World API 5 must upgrade to an API 6 host before installing this package. See [host compatibility](docs/host-compatibility.md) for migration; retain `worlds.generals`, the deployment `.env` and Memory.

## Install

After the release is published, use Cortico's extension page to install `cortico-world-generals@next`, or run this **inside the Cortico host's extension directory** (`extensions/`, or the path set by `CORTICO_EXTENSIONS_DIR`):

```sh
corepack pnpm add --ignore-workspace cortico-world-generals@next
```

Before publication, clone this repository, run `pnpm install`, and select its directory in the host's extension installer. Restart the host after installation.

## First game

1. Add a stable, private account identifier to the deployment's `.env`:

   ```dotenv
   CORTICO_GENERALS_USER_ID=replace-with-your-private-account-id
   ```

   Reuse an existing account's identifier. Anyone with this value can access that account; do not commit it.

2. Enable the World in the deployment's `config.json`:

   ```json
   { "worlds": { "generals": { "enabled": true } } }
   ```

3. Restart the host and read `generals_observe` to verify the connection. If the account needs a username, call `generals_set_username` once with a unique name beginning with `[Bot]`. Registration is confirmed by an empty `error_set_username` server reply, delivered as `generals.account`.

4. For manual play, call `generals_join_private({"room":"your-room"})`. A `join-requested` phase only confirms the request; wait for `phase=lobby`. A human can join `https://bot.generals.io/games/your-room`. Use `generals_set_force_start({"enabled":true})` to vote to start, then read the map and submit adjacent moves.

5. For autonomous play, call `generals_start_agent({"room":"your-room","forceStart":true})`. S1 joins the room and votes after admission. It can play without further model replies. S2 can optionally use `generals_strategy_brief` and `generals_set_intent` to select goals; read [the control contract](docs/contracts.md#control-and-strategic-intents) before replacing an intent.

6. Open **对局画面** on the Generals World page to watch. After a result, call `generals_leave` before joining another game. S1 delegation lasts one game.

Tool examples show names and argument objects, not a separate command-line interface. The host exposes the tools to its Persona.

## Viewer and configuration

The read-only viewer listens on `127.0.0.1`. It shows the current fog view, player colors, armies, the local move cursor, submitted arrows and S1 plans. The white border follows the latest submitted destination; the Bot API supplies no selected-tile state. A processed action index does not prove a successful move or capture.

`viewer.port=0` allocates a port and reuses it across World restarts within the same host process. Set `worlds.generals.viewer.port` to a fixed unused port for a URL that survives host restarts. The World page exposes the current link. See [operations](docs/operations.md) for configuration defaults, OBS and recovery.

## Boundaries

- S1 supports confirmed standard and City-State 1v1 and free-for-all rules. Unsupported rules, allied transfers and tunnels stop autonomous control.
- Without optional pause integration, the host's global pause leaves S1 running. Use `generals_stop_agent` to revoke delegation and request queue clearing, or deactivate the World. The remote game continues; processed moves cannot be recalled.
- There is no automatic reconnection. Restarting the World creates a fresh connection without restoring the room, start vote, delegation or intent.
- Current observations, last-seen facts and policy estimates have separate meanings. Hidden armies are not refreshed from history.
- Movement receipts confirm transmission. Known-mountain steps are skipped while later steps remain in order; filtering can leave a disconnected route.
- S1 search and simulations use stated assumptions and limited budgets. They do not guarantee a defense or victory.

## Documentation

- [Operations and configuration](docs/operations.md)
- [Tools, observations, intents and feedback](docs/contracts.md)
- [Engine and S1 architecture](docs/architecture.md)
- [Host compatibility](docs/host-compatibility.md)
- [Sources and research references](docs/references.md)
- [Release checks and publication](docs/releasing.md)
- [Optional streaming commentary](examples/streaming-commentary.md)

The default [environment prompt](src/ENV_PROMPT.md) describes game mechanics and tool use. It does not prescribe a persona or require commentary. A package or deployment file at `worlds/generals/ENV_PROMPT.md` can override it; see [operations](docs/operations.md#environment-prompt).

## Development

Use Node.js 24.15+ or 22.22.2+ for development with the pinned pnpm version.

```sh
corepack pnpm install
pnpm test
pnpm typecheck
pnpm check:package
pnpm check:host-patch
```

Tests use local WebSocket/HTTP servers, an engine child process and a deterministic arena. They require no account, real bot or external network. The arena uses scripted opponents; its results do not measure strength against human players.

The npm package ships TypeScript source and local viewer assets. Version `0.1.0-rc.2` is intended for the `next` dist-tag. Publishing is performed separately from local checks.

## License

[MIT](LICENSE). This is an independent integration with generals.io; game names and the remote service belong to their respective owners.
