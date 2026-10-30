"""JSONL init/step/close boundary for the packaged S2-aware Harris Blob backend."""
import sys

sys.dont_write_bytecode = True
if sys.version_info < (3, 10):
    raise RuntimeError("city-half-1 requires Python 3.10 or later")

import os

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from harris_env import (  # noqa: E402
    IMPLEMENTATION, Map, build_map, rpc, server_data, start_data,
)
from backend import Backend  # noqa: E402


class Adapter:
    def __init__(self):
        self.backend = None
        self.start = None
        self.game = None
        self.width = 0
        self.height = 0

    def init(self, request):
        self.width = int(request["width"])
        self.height = int(request["height"])
        self.start = start_data(request["playerIndex"], int(request["playerCount"]), request.get("gameId", "local"))
        self.game = None
        self.backend = Backend(
            game_id=request.get("gameId", "local"),
            player_index=int(request["playerIndex"]),
            player_count=int(request["playerCount"]),
            width=self.width,
            height=self.height,
            mode=request.get("mode", "standard"),
            seed=int(request.get("seed", 0)),
            control_epoch=int(request.get("controlEpoch", 1)),
        )
        return {
            "implementation": IMPLEMENTATION,
            "capabilities": self.backend.capabilities(),
            "warmupMs": round(self.backend.warmup_ms, 3),
            "controlEpoch": self.backend.epoch,
        }

    def step(self, request):
        observation = request["observation"]
        data = server_data(observation)
        if self.game is None:
            self.game = build_map(self.start, observation)
        else:
            self.game.update(data)
        context = request.get("context")
        strategy = request.get("strategy")
        result = self.backend.step(self.game, observation, context=context, strategy=strategy)
        result["implementation"] = IMPLEMENTATION
        result["stepObservedTurn"] = int(observation.get("turn", 0))
        return result


def main():
    adapter = Adapter()
    return rpc.run(adapter.init, adapter.step, implementation=IMPLEMENTATION)


if __name__ == "__main__":
    sys.exit(main())
