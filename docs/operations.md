Owner: [`src/config.ts`](../src/config.ts), [`src/proxy.ts`](../src/proxy.ts), [`src/world.ts`](../src/world.ts) and [`src/viewer/server.ts`](../src/viewer/server.ts).

# Operations

Installation and the first-game procedure are in the [English](../README.md#first-game) and [Chinese](../README_zh.md#第一局) quick starts. [Host pause integration](host-compatibility.md) is optional.

## Configuration

All keys below are relative to `worlds.generals` in the deployment's `config.json`. The World page renders the same configuration schema. Restart the World to apply changes.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Mount this World. |
| `serverUrl` | `wss://botws.generals.io/socket.io/?EIO=4&transport=websocket` | Engine.IO 4 WebSocket endpoint. |
| `connectTimeoutMs` | `15000` | Connection timeout, in milliseconds. |
| `snapshotIntervalMs` | `2000` | Minimum interval between map events; observations still read every received frame. |
| `viewer.enabled` | `true` | Start the loopback read-only viewer. |
| `viewer.port` | `0` | Automatic local port; a nonzero value requests that fixed port. |
| `agent.decisionBudgetMs` | `50` | Cooperative search time budget for each S1 decision, in milliseconds. |
| `agent.maxSearchNodes` | `4000` | Search node budget for each S1 decision. |
| `agent.reportIntervalMs` | `10000` | Periodic S2 report interval, in milliseconds; significant changes can report earlier. |

For example, a fixed viewer port and the shipped search budgets:

```json
{
  "worlds": {
    "generals": {
      "enabled": true,
      "viewer": { "enabled": true, "port": 18080 },
      "agent": {
        "decisionBudgetMs": 50,
        "maxSearchNodes": 4000,
        "reportIntervalMs": 10000
      }
    }
  }
}
```

Search can return completed candidates or the disclosed one-step fallback when a budget is exhausted. Larger budgets allow more search; they do not guarantee a better move. Map scans and fallback work can extend elapsed time beyond the cooperative decision budget.

## Accounts and admission

Set `CORTICO_GENERALS_USER_ID` in the deployment's `.env`. It is a private account identifier, supplied separately from the public username. Keep an existing identifier when reusing an account. The World does not include the configured identifier in its own receipts or events.

`generals_set_username` requests a unique name beginning with `[Bot]`. An empty `error_set_username` reply confirms success as `generals.account`; a nonempty reply is an error. `generals_observe.lastError` records server admission errors. If a username is required, register it before retrying admission.

`generals_join_private` requests admission. `queue_update` confirms it and changes `join-requested` to `lobby`. Check the current `phase`, `room` and `lobby` before announcing admission. `lobby.isForcing` records the start vote; `phase=playing` or `generals.start` confirms the game has begun. Another socket using the same account can replace its seat. Stop this World before running a separate account probe.

## Viewer and OBS

Open **对局画面** on the Generals World page. The viewer uses the existing game connection and publishes each received frame independently of model-event throttling. It restores no historical ownership or army counts inside current fog.

The listener binds only `127.0.0.1`. An OBS browser source running on the same machine can use the displayed URL. `viewer.port=0` retains its allocated port across World recreation within the same host process and shared configuration object. A host restart may allocate a different port; use a fixed unused port for a persistent OBS URL. The configuration file is not rewritten with an automatically assigned port.

The white border is a local cursor at the latest submitted destination. The Bot API supplies no selected-tile state. White arrows are locally submitted steps awaiting a reported processing index. Confirmation removes the arrows without proving combat success. A clear request removes the local display without claiming server acknowledgement.

Pale blue arrows show S1's current plans, including gathering and defense branches. Only the next step is sent. A plan verified for its next step alone displays that step alone. Linked operator pause, control or intent changes, a new observation without a fresh decision, and game completion hide obsolete plans. A disconnect or leaving clears the board; a result retains the last observed board. Display zoom and board-only mode affect presentation and send no moves. Viewer routes are excluded from model-facing observations.

A viewer startup error, including a port conflict, appears on the World page while the game connection remains available. Choose another port and restart the World. The viewer reconnects its event stream at the same URL when the listener returns.

## Pause, takeover and recovery

On unmodified Cortico 0.2.3, global pause stops event delivery while S1 continues playing. Check the World page or the [reported pause capability](contracts.md#control-and-strategic-intents) before relying on pause to stop actions.

With [optional host pause integration](host-compatibility.md), operator pause stops new S1 movement and autonomous start votes, invalidates the decision and intent, and requests clearing pending moves. Resume retains the delegation with a new control epoch; S2 must submit a new intent if needed.

Use `generals_stop_agent` to stop S1 or take over manually. It revokes delegation, invalidates the intent and requests clearing remaining moves. Deactivating the World also stops its local engine. The remote game continues in either case, and clearing cannot recall actions already processed. Inspect the current map and `moveProgress` before issuing a replacement route. Manual control has no S1 defense.

Disconnects, malformed transport/map data and engine exits require restarting the World. Restart creates a fresh connection with `phase=connected` and `room=null`; it restores no room, vote, delegation or intent. Old archived lobby events do not establish the new connection's admission. After `won` or `lost`, leave before joining another room and delegate again if S1 is desired.

## Environment prompt

[`src/ENV_PROMPT.md`](../src/ENV_PROMPT.md) is declared as an environment template. The host can use a bot package or deployment override at `worlds/generals/ENV_PROMPT.md`. Overrides replace the template, so retain the tool contracts and fact boundaries when editing. Follow the host Persona's prefix-reload procedure after changing a system prefix that was already loaded.

The template contains game mechanics, optional strategic advice, observation semantics, delegation and manual-tool use. Streaming wording is an [optional addition](../examples/streaming-commentary.md). Neither the World nor that example supplies a persona or an output channel.
