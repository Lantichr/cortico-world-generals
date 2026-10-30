Owner: `adapter.py`, `backend.py`, `native_candidate.py`, `harris_env.py`, `rpc.py` and `vendor/`.

# city-half-1

Implementation: `harris@71e6b58:bot_blob+s2-city-half/1`. Python 3.10+; standard library only.
The World starts `adapter.py` with isolated imports, unbuffered JSONL and bytecode disabled.
The process has no game connection or LLM client. Its input is the current server view and
versioned S2 intent; the TypeScript World validates and submits its single next move.

`backend.py` and `native_candidate.py` preserve the evaluated city-half-1 policy. The S2
execution layer supports auto, expand, capture_city, gather, defend, scout and attack_general.
It uses Harris routes and move selection, checks reserves and avoided tiles, and can preempt
tasks for visible emergency defense or an adjacent general capture. Pending moves use army
changes to track the task carrier; server processing remains a separate World observation.
When a visible defense demand exists, a departure from the general to an owned city sends half.
This rule applies to that directed edge and is unrelated to the City-State game mode.

`vendor/` is the required subset of
[harrischristiansen/generals-bot](https://github.com/harrischristiansen/generals-bot),
commit `71e6b582a862d9ae6d8667e1978e5ade908abfd2`, under its included MIT license,
Copyright (c) 2017 Harris Christiansen. The package uses `BotConfig.strong()`.
The unused `bot_base` import in `base/bot_moves.py` is removed; the standalone `startup`
import in `bot_blob.py` runs only under `__main__`. These import changes exclude the
network client and graphical viewer without changing policy functions.

The JSONL adapter, bridge and RPC loop are MIT-licensed extension code. `harris_env.py`
resolves only the packaged vendor directory. No workspace paths, virtual environment or
third-party Python modules are required. The original adapter's first Map construction is
blind; a second observation populates tiles. Native path work is measured in elapsed time;
`search.nodes` counts only the execution layer's bounded search expansions.
Bounded planning permits 24,000 expansions per frame, 3,000 force states and 4,096 structural
nodes per call, up to eight sources and depth 64. Native candidate selection examines at most
twelve candidates; its Harris path scans do not consume the bounded expansion counter.
