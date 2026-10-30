"""Deterministic small-map simulator used by the backend tests.

It is not the official engine; it is a real movement/production/vision simulation whose
observations have the same shape and fog semantics as the referee, so the pinned Harris Map
and the backend process real updates rather than scripted expected returns.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
if IMPL not in sys.path:
    sys.path.insert(0, IMPL)

from adapter import Adapter  # noqa: E402

DIRS4 = ((0, 1), (0, -1), (1, 0), (-1, 0))


class Sim:
    def __init__(self, width, height, players=2, cities=(), mountains=(), seed=7):
        self.w = width
        self.h = height
        self.players = players
        self.seed = seed
        self.owner = [-1] * (width * height)
        self.army = [0] * (width * height)
        self.city = [False] * (width * height)
        self.general = [None] * (width * height)   # index -> player
        self.dead = [False] * players
        self.turn = 1
        for index in mountains:
            self.owner[index] = -2
        for index in cities:
            self.city[index] = True

    # ---------------------------------------------------------------- setup
    def tile(self, x, y, owner=None, army=0, city=False, general=None):
        index = self.idx(x, y)
        self.owner[index] = -1 if owner is None else owner
        self.army[index] = army
        if city:
            self.city[index] = True
        if general is not None:
            self.general[index] = general
            self.owner[index] = general
        return index

    def mountain(self, x, y):
        index = self.idx(x, y)
        self.owner[index] = -2
        self.army[index] = 0
        return index

    def idx(self, x, y):
        return y * self.w + x

    def xy(self, index):
        return index % self.w, index // self.w

    def general_of(self, player):
        for index, owner in enumerate(self.general):
            if owner == player:
                return index
        return None

    # ---------------------------------------------------------------- view
    def visible(self, player):
        seen = [False] * (self.w * self.h)
        for index, owner in enumerate(self.owner):
            if owner != player:
                continue
            seen[index] = True
            x, y = self.xy(index)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < self.w and 0 <= ny < self.h:
                        seen[ny * self.w + nx] = True
        return seen

    def observation(self, player):
        seen = self.visible(player)
        terrain, armies = [], []
        for index, owner in enumerate(self.owner):
            if not seen[index]:
                terrain.append(-3)
                armies.append(0)
            elif owner == -2:
                terrain.append(-2)
                armies.append(0)
            else:
                terrain.append(owner)
                armies.append(self.army[index])
        cities = [index for index in range(len(seen)) if seen[index] and self.city[index]]
        generals = []
        for other in range(self.players):
            index = self.general_of(other)
            generals.append(index if index is not None and seen[index] else -1)
        scores = []
        for other in range(self.players):
            owned = [i for i, owner in enumerate(self.owner) if owner == other]
            scores.append({"i": other, "total": sum(self.army[i] for i in owned),
                           "tiles": len(owned), "dead": self.dead[other]})
        return {"width": self.w, "height": self.h, "playerIndex": player, "playerCount": self.players,
                "turn": self.turn, "armies": armies, "terrain": terrain, "cities": cities,
                "generals": generals, "scores": scores,
                "teams": list(range(self.players))}

    # ---------------------------------------------------------------- rules
    def neighbours4(self, index):
        x, y = self.xy(index)
        for dx, dy in DIRS4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < self.w and 0 <= ny < self.h:
                yield ny * self.w + nx

    def apply_move(self, player, move):
        source, target = move["from"], move["to"]
        if target not in set(self.neighbours4(source)):
            raise AssertionError("non-adjacent move %r" % (move,))
        if self.owner[source] != player:
            raise AssertionError("source not owned")
        half = bool(move.get("half"))
        sent = self.army[source] // 2 if half else self.army[source] - 1
        if sent <= 0:
            raise AssertionError("empty move")
        self.army[source] -= sent
        captured_general = None
        if self.owner[target] == player:
            self.army[target] += sent
        elif sent > self.army[target]:
            if self.general[target] is not None:
                captured_general = self.general[target]
                self.general[target] = None
                self.dead[captured_general] = True
            self.owner[target] = player
            self.army[target] = sent - self.army[target]
        else:
            self.army[target] -= sent
            if self.army[target] == 0 and self.owner[target] >= 0:
                pass
        self.turn += 1
        if self.turn % 2 == 0:            # official production phase: even turns
            self.produce()
        return {"captured_general": captured_general}

    def advance(self):
        self.turn += 1
        if self.turn % 2 == 0:
            self.produce()

    def produce(self):
        for index, owner in enumerate(self.owner):
            if owner is None or owner < 0:
                continue
            is_general = self.general[index] == owner
            if self.city[index] or is_general:
                self.army[index] += 1
        if self.turn % 50 == 0:                          # official land growth: every 50 turns
            for index, owner in enumerate(self.owner):
                if owner is not None and owner >= 0:
                    self.army[index] += 1


class Harness:
    """Adapter + Sim; observations are generated from the true board each turn."""

    def __init__(self, sim, player=0, game_id="t", seed=None, mode="standard", control_epoch=1):
        self.sim = sim
        self.player = player
        self.game_id = game_id
        self.epoch = control_epoch
        self.adapter = Adapter()
        self.init = self.adapter.init({
            "gameId": game_id, "playerIndex": player, "playerCount": sim.players,
            "width": sim.w, "height": sim.h, "mode": mode,
            "seed": sim.seed if seed is None else seed, "controlEpoch": control_epoch,
        })

    def observe(self):
        return self.sim.observation(self.player)

    def step(self, strategy=None, context=None, revision=None):
        context = context or {"gameId": self.game_id, "controlEpoch": self.epoch,
                              "revision": revision if revision is not None else self.sim.turn + 1}
        return self.adapter.step({"observation": self.observe(), "context": context,
                                  "strategy": strategy})

    def prime(self):
        """First Map build is blind (the pinned Map applies tile values on update)."""
        result = self.step()
        self.sim.advance()
        return result

    def play(self, strategy=None, context=None, revision=None):
        result = self.step(strategy=strategy, context=context, revision=revision)
        if result["move"]:
            self.sim.apply_move(self.player, result["move"])
        else:
            self.sim.advance()
        return result


def intent(goal, revision=1, based=0, expires=999, constraints=None, preferences=None,
           game="t", epoch=1):
    value = {"gameId": game, "controlEpoch": epoch, "revision": revision,
             "basedOnTurn": based, "expiresTurn": expires, "goal": goal}
    if constraints is not None:
        value["constraints"] = constraints
    if preferences is not None:
        value["preferences"] = preferences
    return value


def state(active, status="following", last_revision=None, reason=None):
    return {"active": active, "status": status, "reason": reason,
            "lastRevision": last_revision if last_revision is not None else (active["revision"] if active else 0),
            "lastRejection": None}


def goal(kind, target=None, player=None):
    if kind in ("capture_city", "gather", "defend", "scout"):
        x, y = target
        return {"kind": kind, "target": {"x": x, "y": y}}
    if kind == "attack_general":
        return {"kind": kind, "player": player}
    return {"kind": kind}


def coord(sim, index):
    return sim.xy(index)
