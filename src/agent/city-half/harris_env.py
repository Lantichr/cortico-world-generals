"""Packaged bridge to the pinned Harris Map and autonomous policy."""
import os
import sys

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
HARRIS = os.path.join(HERE, "vendor")
for _path in (HARRIS,):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import bot_blob  # noqa: E402
import rpc  # noqa: E402
from base import bot_moves  # noqa: E402
from base.client.map import Map  # noqa: E402
from base.client.constants import (  # noqa: E402
    TILE_EMPTY, TILE_MOUNTAIN, TILE_FOG, TILE_OBSTACLE, DEFEND_GENERAL_RADIUS,
)

IMPLEMENTATION = "harris@71e6b58:bot_blob+s2-city-half/1"
UPSTREAM = "harrischristiansen/generals-bot@71e6b582a862d9ae6d8667e1978e5ade908abfd2"


def diff_for(values):
    """A diff that replaces the whole array: [0, len, ...values]."""
    return [0, len(values)] + list(values)


def server_data(observation):
    """The exact start/step payload the original Harris adapter builds."""
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


def start_data(player_index, player_count, game_id):
    return {
        "playerIndex": int(player_index),
        "usernames": ["player%d" % i for i in range(int(player_count))],
        "replay_id": str(game_id),
        "swamps": [],
    }


def build_map(start, observation):
    return Map(start, server_data(observation))


def warmup_map(width, height, player_index, player_count):
    """The original adapter's throwaway 5x5-ish map used to warm imports and first-call costs."""
    size = width * height
    armies = [0] * size
    terrain = [-3] * size
    armies[0], terrain[0] = 5, int(player_index)
    if width > 1:
        armies[1], terrain[1] = 1, int(player_index)
    data = server_data({
        "width": width, "height": height, "armies": armies, "terrain": terrain,
        "cities": [], "generals": [-1] * player_count,
        "scores": [], "turn": 1,
    })
    data["generals"][player_index] = 0
    return Map(start_data(player_index, player_count, "warmup"), data)


class MoveSink:
    def __init__(self):
        self.move = None

    def place_move(self, source, dest, move_half=False):
        self.move = (source, dest, bool(move_half))
