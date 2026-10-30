"""Adapter for harrischristiansen/generals-bot@71e6b58 (bot_blob).

The upstream strategy is `bot_blob.make_move(bot, map)`; the adapter supplies the
`Map` object the upstream client would have built from server diffs, plus a bot
stub whose `place_move` replaces the socket send. No strategy code is changed.
"""
import os
import random
import sys
import time

# pygame prints its support banner on stdout at import time, which would corrupt the
# JSONL protocol; the banner is the only thing this flag suppresses.
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "..", "src", "agent", "city-half", "vendor"))
sys.path.insert(0, os.path.join(ROOT, "..", "src", "agent", "city-half"))

import bot_blob  # noqa: E402
from base.client.map import Map  # noqa: E402

import rpc  # noqa: E402


def diff_for(values):
    """A diff that replaces the whole array: [0, len, ...values]."""
    return [0, len(values)] + list(values)


def server_data(observation):
    width, height = observation["width"], observation["height"]
    armies = list(observation["armies"])
    terrain = list(observation["terrain"])
    return {
        "map_diff": diff_for([width, height] + armies + terrain),
        "cities_diff": diff_for(sorted(observation["cities"])),
        "generals": list(observation["generals"]),
        "scores": [
            {"i": score["i"], "total": score["total"], "tiles": score["tiles"], "dead": bool(score.get("dead"))}
            for score in observation["scores"]
        ],
        "turn": observation["turn"],
    }


class MoveSink:
    """Stands in for the client: records the single move the strategy places."""

    def __init__(self):
        self.move = None

    def place_move(self, source, dest, move_half=False):
        self.move = (source, dest, bool(move_half))


class Adapter:
    def __init__(self):
        self.game = None
        self.width = 0
        self.height = 0
        self.start_data = None

    def init(self, request):
        self.width = int(request["width"])
        self.height = int(request["height"])
        self.start_data = {
            "playerIndex": int(request["playerIndex"]),
            "usernames": ["player%d" % i for i in range(int(request["playerCount"]))],
            "replay_id": str(request.get("gameId", "local")),
            "swamps": [],
        }
        # Warm the upstream map/strategy path on a throwaway game so the first real
        # turn is not charged for import-time or first-call costs.
        random.seed(int(request.get("seed", 0)))
        started = time.perf_counter()
        warmup = self.build_warmup_map()
        sink = MoveSink()
        bot_blob.make_move(sink, warmup)
        warmup_ms = (time.perf_counter() - started) * 1000.0
        # The strategy draws from the global `random` module (should_move_half and the
        # tile scan order). Re-seed after warmup so its draws do not shift the game
        # stream, and clear the module-level bot/map the warmup call left behind.
        random.seed(int(request.get("seed", 0)))
        bot_blob._bot = None
        bot_blob._map = None
        self.game = None
        return {
            "implementation": "harrischristiansen/generals-bot@71e6b58:bot_blob",
            "warmupMs": round(warmup_ms, 3),
        }

    def build_warmup_map(self):
        size = self.width * self.height
        armies = [0] * size
        terrain = [-3] * size
        armies[0], terrain[0] = 5, int(self.start_data["playerIndex"])
        if self.width > 1:
            armies[1], terrain[1] = 1, int(self.start_data["playerIndex"])
        data = server_data({
            "width": self.width, "height": self.height, "armies": armies, "terrain": terrain,
            "cities": [], "generals": [0] + [-1] * (len(self.start_data["usernames"]) - 1),
            "scores": [], "turn": 1,
        })
        return Map(self.start_data, data)

    def step(self, request):
        data = server_data(request["observation"])
        if self.game is None:
            self.game = Map(self.start_data, data)
        else:
            self.game.update(data)
        sink = MoveSink()
        bot_blob.make_move(sink, self.game)
        if sink.move is None:
            return None
        source, dest, half = sink.move
        return {
            "from": source.y * self.width + source.x,
            "to": dest.y * self.width + dest.x,
            "half": half,
        }


def main():
    adapter = Adapter()
    return rpc.run(adapter.init, adapter.step, implementation="harrischristiansen/generals-bot@71e6b58:bot_blob")


if __name__ == "__main__":
    sys.exit(main())
