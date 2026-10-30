"""S2 execution layer for the pinned Harris Blob.

Current facts (visibility, owner, army, scores) come only from the raw referee
observation. The Harris Map is used for discovered structure and autonomous play; its fogged
tiles retain old owners and armies, so they are historical estimates, never current facts.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from harris_env import (
    IMPLEMENTATION, MoveSink, TILE_FOG, TILE_MOUNTAIN, TILE_OBSTACLE,
    bot_blob, bot_moves,
)
from native_candidate import build_native_candidate

SUPPORTED_GOALS = ("auto", "expand", "capture_city", "gather", "defend", "scout", "attack_general")
SUPPORTED_EMPHASIS = ("balanced", "economy", "pressure", "information")
SUPPORTED_RISK = ("low", "normal", "high")
EMERGENCY_HORIZON = 8
MAX_PLAN_DEPTH = 64
MAX_PLAN_STATES = 3000
MAX_STRUCTURAL_NODES = 4096
MAX_PLAN_NODES = MAX_PLAN_STATES + MAX_STRUCTURAL_NODES
MAX_FRAME_PLAN_NODES = 24000
MAX_STRUCTURAL_STARTS = 8
MAX_PLAN_SOURCES = 8


def _index(tile, width):
    return tile.y * width + tile.x


def _passable(tile):
    if tile.tile == TILE_MOUNTAIN:
        return False
    if tile.tile == TILE_OBSTACLE and not (tile.isCity or tile.isGeneral):
        return False
    return True


def _half_armies(armies, half):
    return armies // 2 if half else armies - 1


class Observation:
    """The raw referee frame: the only source of current facts."""

    def __init__(self, raw, player):
        self.raw = raw
        self.width = int(raw["width"])
        self.height = int(raw["height"])
        self.n = self.width * self.height
        self.turn = int(raw["turn"])
        self.player = int(raw["playerIndex"])
        self.terrain = [int(value) for value in raw["terrain"]]
        self.armies = [int(value) for value in raw["armies"]]
        self.generals = [int(value) for value in raw["generals"]]
        self.cities = {int(value) for value in raw.get("cities", [])}
        self.visible = [value not in (TILE_FOG, TILE_OBSTACLE) for value in self.terrain]
        self.owner = [self.terrain[i] if self.visible[i] and self.terrain[i] >= 0 else None
                      for i in range(self.n)]
        self.scores = {int(entry.get("i")): entry for entry in raw.get("scores", [])}

    def is_visible(self, index):
        return self.visible[index]

    def is_self(self, index):
        return self.owner[index] == self.player

    def known_wall(self, index):
        return self.visible[index] and self.terrain[index] == TILE_MOUNTAIN

    def army(self, index):
        return self.armies[index]

    def dead(self, player):
        entry = self.scores.get(player)
        return bool(entry and entry.get("dead"))


@dataclass
class Constraints:
    avoid: set = field(default_factory=set)
    reserves: dict = field(default_factory=dict)
    half_edges: set = field(default_factory=set)

    def empty(self):
        return not self.avoid and not self.reserves

    def check(self, obs, gamemap, move, held=(), risk="normal", allow_fog_target=False,
              require_capture=False):
        """Validate rule legality and hard constraints for one final move.

        require_capture is candidate selection for task attacks: it asks that the chosen split
        can actually take the destination. It is not a general legality rule, so the autonomous
        blob may still make a legal weakening attack when no intent/constraints apply.
        """
        if not isinstance(move, dict):
            return "strategy_schema"
        if type(move.get("from")) is not int or type(move.get("to")) is not int \
                or type(move.get("half")) is not bool:
            return "strategy_schema"
        source, target = move["from"], move["to"]
        if not (0 <= source < obs.n) or not (0 <= target < obs.n):
            return "strategy_bounds"
        sx, sy = source % obs.width, source // obs.width
        tx, ty = target % obs.width, target // obs.width
        if abs(sx - tx) + abs(sy - ty) != 1:
            return "strategy_adjacency"
        if source in self.avoid or target in self.avoid:
            return "strategy_avoid_tile"
        if source in held:
            return "strategy_gather_target_held"
        if not obs.is_self(source) or obs.army(source) <= 1:
            return "strategy_source_not_currently_owned"
        if obs.known_wall(target):
            return "strategy_target_not_passable"
        destination = gamemap.grid[ty][tx]
        if not _passable(destination):
            return "strategy_target_not_passable"
        sent = _half_armies(obs.army(source), move["half"])
        if sent <= 0:
            return "strategy_no_army"
        if require_capture and obs.is_visible(target) and not obs.is_self(target) \
                and sent <= obs.army(target):
            return "strategy_insufficient_capture"
        if risk == "low" and not obs.is_visible(target) and not allow_fog_target:
            return "strategy_low_risk_fog_landing"
        reserve = max(1, int(self.reserves.get(source, 1)))
        if obs.army(source) - sent < reserve:
            return "strategy_reserve"
        return None


def _parse_preferences(active):
    raw = active.get("preferences")
    if raw is None:
        return None
    emphasis = raw.get("emphasis")
    risk = raw.get("risk")
    if emphasis not in SUPPORTED_EMPHASIS or risk not in SUPPORTED_RISK:
        return {"unsupported": "unsupported_preferences"}
    return {"emphasis": emphasis, "risk": risk}


class Backend:
    def __init__(self, game_id, player_index, player_count, width, height, mode, seed, control_epoch=1):
        self.game_id = str(game_id)
        self.player_index = int(player_index)
        self.player_count = int(player_count)
        self.width = int(width)
        self.height = int(height)
        self.mode = str(mode)
        self.seed = int(seed)
        self.epoch = int(control_epoch)
        self.active_revision = 0
        self.last_revision = 0
        self.completed_revision = None
        self.context_revision = None
        self.last_obs_turn = None
        self.task = None
        self.known_generals = {}
        self.obs = None
        self.last_rejected_step = None
        self.last_auto_rejected = None
        self.last_auto_adjustment = None
        self.turn = 0
        self._plan_budget_remaining = MAX_FRAME_PLAN_NODES
        self._plan_nodes_spent = 0
        self._plan_calls = 0
        self._plan_cache = {}
        self._native_cache = {}
        self._frame_defense = None
        self._frame_defense_ready = False
        self._frame_half_edges = set()
        self._warmup()

    # ---------------------------------------------------------------- setup
    def _warmup(self):
        import random

        from harris_env import warmup_map

        random.seed(self.seed)
        started = time.perf_counter()
        warm = warmup_map(self.width, self.height, self.player_index, self.player_count)
        bot_blob.make_move(MoveSink(), warm)
        self.warmup_ms = (time.perf_counter() - started) * 1000.0
        random.seed(self.seed)
        bot_blob._bot = None
        bot_blob._map = None

    def capabilities(self):
        return {
            "upstream": "harrischristiansen/generals-bot@71e6b582a862d9ae6d8667e1978e5ade908abfd2",
            "implementation": IMPLEMENTATION,
            "goals": list(SUPPORTED_GOALS),
            "preferences": {"emphasis": list(SUPPORTED_EMPHASIS), "risk": list(SUPPORTED_RISK),
                            "emphasis_scope": "one_step_expand_blocked_fallback_auto_with_preferences",
                            "risk_scope": "all_routes_and_final_landings"},
            "constraints": ["avoidTiles", "reserves", "gather_defend_target_hold"],
            "constraint_scope": "every_submitted_move_including_preemption_and_fallback",
            "current_facts": "raw_observation",
            "preemption": ["emergency_general_defense", "one_step_general_capture"],
            "task_persistence": True,
            "main_force_confirmation": "raw_observation_army_delta",
            "path_planning": {"version": "v2-force", "model": "bounded_simple_path_step_split",
                              "maxDepth": MAX_PLAN_DEPTH, "maxStates": MAX_PLAN_STATES,
                              "maxStructuralNodes": MAX_STRUCTURAL_NODES,
                              "maxPerCallNodes": MAX_PLAN_NODES,
                              "maxFrameNodes": MAX_FRAME_PLAN_NODES,
                              "maxCandidateSources": MAX_PLAN_SOURCES,
                              "futureProductionCredited": False,
                              "unknownTerrain": "conditional_structural_route"},
            "native_candidate": {"version": "native-candidate/3",
                                 "path": "find_largest/path_to + best_gather_path helper",
                                 "move": "move_path/move_gather_step",
                                 "prefix": "gamemap.canStepPath first non-owned",
                                 "maxCandidates": 12,
                                 "executorScope": "fixed_target_prefix_transport_route"},
            "unsupported": ["arbitrary_reserve_numbers", "multi_force_joint_search", "scripted_routes"],
        }

    # ---------------------------------------------------------------- helpers
    def _tile(self, gamemap, index):
        return gamemap.grid[index // self.width][index % self.width]

    def _idx(self, tile):
        return _index(tile, self.width)

    def _own_tiles(self, gamemap, minimum=2):
        tiles = [self._tile(gamemap, i) for i in range(self.obs.n)
                 if self.obs.is_self(i) and self.obs.army(i) >= minimum]
        tiles.sort(key=lambda tile: (-self.obs.army(self._idx(tile)), self._idx(tile)))
        return tiles

    def _spend_plan_node(self):
        """Consume one real expansion from the shared per-frame planning budget."""
        if self._plan_budget_remaining <= 0:
            return False
        self._plan_budget_remaining -= 1
        self._plan_nodes_spent += 1
        return True

    def _structural_path(self, gamemap, start, target, visited, constraints, risk, held=(),
                         budget=None):
        """Bounded passable BFS, used where the force-aware search stops at unknown terrain."""
        obs = self.obs
        low_risk = risk == "low"
        limit = MAX_STRUCTURAL_NODES if budget is None else min(MAX_STRUCTURAL_NODES, max(0, budget))
        if start == target:
            return [start], 0, False
        if limit <= 0:
            return None, 0, False
        seen = set(visited)
        seen.add(start)
        parent = {start: None}
        frontier = [start]
        nodes = 0
        exhausted = False
        while frontier and nodes < limit:
            next_frontier = []
            for current in frontier:
                tile = self._tile(gamemap, current)
                for neighbor in tile.neighbors(includeSwamps=True):
                    if nodes >= limit or not self._spend_plan_node():
                        exhausted = True
                        break
                    nodes += 1
                    index = self._idx(neighbor)
                    if index in seen or index in constraints.avoid:
                        continue
                    if index in held and index != target:
                        continue
                    if not _passable(neighbor):
                        continue
                    if low_risk and index != target and not obs.is_visible(index):
                        continue
                    seen.add(index)
                    parent[index] = current
                    if index == target:
                        path, cursor = [], target
                        while cursor is not None:
                            path.append(cursor)
                            cursor = parent[cursor]
                        return list(reversed(path)), nodes, exhausted
                    next_frontier.append(index)
                if exhausted:
                    break
            frontier = next_frontier
        return None, nodes, exhausted

    def _plan_path(self, gamemap, source, target, constraints, risk, held=(), allow_fog_target=False):
        """Per-step cache wrapper; repeated source/main evaluation reuses the same plan."""
        key = (source, target, risk, bool(allow_fog_target),
               tuple(sorted(constraints.avoid)), tuple(sorted(constraints.reserves.items())),
               tuple(sorted(constraints.half_edges)),
               tuple(sorted(held)), MAX_PLAN_STATES, MAX_STRUCTURAL_NODES, MAX_FRAME_PLAN_NODES)
        self._plan_calls += 1
        if key in self._plan_cache:
            cached = dict(self._plan_cache[key])
            cached.update({"nodes": 0, "planMs": 0.0, "cached": True,
                           "originalNodes": self._plan_cache[key].get("nodes", 0)})
            return cached
        plan = self._plan_path_uncached(gamemap, source, target, constraints, risk, held,
                                        allow_fog_target)
        self._plan_cache[key] = dict(plan)
        return plan

    def _plan_path_uncached(self, gamemap, source, target, constraints, risk, held=(),
                            allow_fog_target=False):
        """Bounded force-aware route evaluation on the current raw frame.

        A state is (tile, army after arriving, simple path). Each step chooses full (A-1) or
        half (floor(A/2)) subject to the source reserve; own tiles add their current army once;
        visible enemy/empty tiles must be captured by the sent split. Unknown terrain ends the
        exact segment and falls back to a structural route marked conditional. No future
        production is credited, and no tile is revisited.
        """
        started = time.perf_counter()
        obs = self.obs
        summary = {"path": None, "splits": [], "army": None, "delivered": None, "steps": 0,
                   "feasible": False, "conditional": False, "nodes": 0, "depth": 0,
                   "boundHit": False, "reason": "no_route", "planMs": 0.0}
        if source is None or target is None:
            return summary
        if not (0 <= source < obs.n) or not (0 <= target < obs.n):
            return summary
        if source in constraints.avoid or target in constraints.avoid or source in held:
            summary["reason"] = "hard_constraint"
            return summary
        if not obs.is_self(source) or obs.army(source) <= 1:
            summary["reason"] = "source_not_usable"
            return summary
        if not _passable(self._tile(gamemap, source)) or not _passable(self._tile(gamemap, target)):
            summary["reason"] = "not_passable"
            return summary
        low_risk = risk == "low"

        def split_for(army, index, enemy_army=None, destination=None):
            reserve = max(1, int(constraints.reserves.get(index, 1)))
            forced_half = (index, destination) in constraints.half_edges
            options = []
            for half in (True,) if forced_half else (False, True):
                sent = _half_armies(army, half)
                if sent <= 0 or army - sent < reserve:
                    continue
                if enemy_army is not None and sent <= enemy_army:
                    continue
                options.append((sent, half))
            if not options:
                return None
            return max(options, key=lambda item: (item[0], not item[1]))

        queue = [(source, obs.army(source), (source,), (), 0)]
        best = {source: obs.army(source)}
        candidates = []
        boundaries = []
        best_feasible_depth = None
        nodes = 0
        label_nodes = 0
        head = 0
        while head < len(queue):
            if nodes >= MAX_PLAN_NODES:
                summary["boundHit"] = True
                break
            current, army, path, splits, depth = queue[head]
            head += 1
            if best_feasible_depth is not None and depth >= best_feasible_depth:
                break
            if depth >= MAX_PLAN_DEPTH:
                summary["boundHit"] = True
                continue
            tile = self._tile(gamemap, current)
            for neighbor in tile.neighbors(includeSwamps=True):
                if nodes >= MAX_PLAN_NODES or label_nodes >= MAX_PLAN_STATES:
                    summary["boundHit"] = True
                    break
                if not self._spend_plan_node():
                    summary["boundHit"] = True
                    break
                nodes += 1
                label_nodes += 1
                index = self._idx(neighbor)
                if index in path or index in constraints.avoid:
                    continue
                if index in held and index != target:
                    continue
                if not _passable(neighbor):
                    continue
                if not obs.is_visible(index):
                    if low_risk and not (index == target and allow_fog_target):
                        continue
                    # Defer structural searches until the visible shortest route is resolved.
                    boundaries.append((current, army, path, splits, index))
                    continue
                if index == target:
                    if obs.is_self(index):
                        chosen = split_for(army, current, destination=index)
                        if chosen is None:
                            continue
                        sent, half = chosen
                        arrival = obs.army(index) + sent
                        delivered = sent
                    else:
                        enemy = obs.army(index)
                        chosen = split_for(army, current, enemy, destination=index)
                        if chosen is None:
                            continue
                        sent, half = chosen
                        arrival = sent - enemy
                        delivered = arrival
                    candidates.append((1, -len(path), arrival, {
                        "path": list(path) + [index], "splits": list(splits) + [half],
                        "army": arrival, "delivered": delivered, "steps": len(path),
                        "feasible": True, "conditional": False, "reason": "known_feasible"}))
                    best_feasible_depth = len(path) if best_feasible_depth is None \
                        else min(best_feasible_depth, len(path))
                    continue
                if obs.is_self(index):
                    chosen = split_for(army, current, destination=index)
                    if chosen is None:
                        continue
                    sent, half = chosen
                    arrival = obs.army(index) + sent
                else:
                    enemy = obs.army(index)
                    chosen = split_for(army, current, enemy, destination=index)
                    if chosen is None:
                        continue
                    sent, half = chosen
                    arrival = sent - enemy
                if arrival <= 0 or arrival <= best.get(index, -1):
                    continue
                best[index] = arrival
                queue.append((index, arrival, path + (index,), splits + (half,), depth + 1))
        if not any(candidate[0] for candidate in candidates):
            for _, _, boundary_path, boundary_splits, boundary_index in boundaries[:MAX_STRUCTURAL_STARTS]:
                if nodes >= MAX_PLAN_NODES:
                    summary["boundHit"] = True
                    break
                rest, rest_nodes, rest_exhausted = self._structural_path(
                    gamemap, boundary_index, target, set(boundary_path), constraints, risk, held,
                    budget=MAX_PLAN_NODES - nodes)
                nodes += rest_nodes
                if rest_exhausted:
                    summary["boundHit"] = True
                if rest:
                    full_path = list(boundary_path) + rest
                    candidates.append((0, -len(full_path), 0, {
                        "path": full_path, "splits": list(boundary_splits) + [None],
                        "army": None, "delivered": None, "steps": len(full_path) - 1,
                        "feasible": False, "conditional": True, "reason": "unknown_boundary"}))
        if candidates:
            candidate = max(candidates, key=lambda item: (item[0], item[1], item[2]))
            summary.update(candidate[3])
        else:
            # A known target may be structurally reachable but not capturable with the force
            # available now; keep that distinction so callers do not claim a capture.
            structural, structural_nodes, structural_exhausted = self._structural_path(
                gamemap, source, target, (), constraints, risk, held,
                budget=MAX_PLAN_NODES - nodes)
            nodes += structural_nodes
            if structural_exhausted:
                summary["boundHit"] = True
            if structural:
                summary.update({"path": structural, "splits": [], "army": None, "delivered": None,
                                "steps": len(structural) - 1, "feasible": False,
                                "conditional": not obs.is_visible(target),
                                "reason": "insufficient_force" if obs.is_visible(target) else "unknown_boundary"})
                if summary["boundHit"]:
                    summary["conditional"] = True
                    summary["reason"] = "bound_hit"
            elif summary["boundHit"]:
                summary["conditional"] = True
                summary["reason"] = "bound_hit"
        summary["nodes"] = int(nodes)
        summary["depth"] = summary["steps"]
        summary["planMs"] = round((time.perf_counter() - started) * 1000.0, 3)
        return summary

    def _safe_path(self, gamemap, source, target, constraints, risk, max_sent=None):
        """Compatibility wrapper: return the planned route without the force summary."""
        return self._plan_path(gamemap, source, target, constraints, risk).get("path")

    def _move(self, source, target, half=False):
        return {"from": int(source), "to": int(target), "half": bool(half)}

    def _capture_move(self, gamemap, source, step_to, target, constraints, held, risk,
                      allow_fog_target=False, preferred_half=None):
        order = (False, True)
        if preferred_half is not None:
            order = (preferred_half, not preferred_half)
        if (source, step_to) in constraints.half_edges:
            order = (True,)
        for half in order:
            sent = _half_armies(self.obs.army(source), half)
            if sent <= 0:
                continue
            move = self._move(source, step_to, half)
            if constraints.check(self.obs, gamemap, move, held, risk, allow_fog_target,
                                 require_capture=True) is not None:
                continue
            return move, sent
        return None, 0

    def _choose_move(self, gamemap, source, target, constraints, held, risk, allow_fog_target=False,
                     require_capture=False, preferred_half=None):
        order = (False, True)
        if preferred_half is not None:
            order = (preferred_half, not preferred_half)
        if (source, target) in constraints.half_edges:
            order = (True,)
        for half in order:
            move = self._move(source, target, half)
            if constraints.check(self.obs, gamemap, move, held, risk, allow_fog_target,
                                 require_capture=require_capture) is None:
                return move
        return None

    def _produces(self, index):
        general = self.obs.generals[self.player_index] if self.player_index < len(self.obs.generals) else -1
        return index in self.obs.cities or index == general

    def _make_pending(self, move, revision):
        return {
            "move": dict(move),
            "from": move["from"], "to": move["to"], "half": move["half"],
            "sent": _half_armies(self.obs.army(move["from"]), move["half"]),
            "turn": self.obs.turn, "revision": revision,
            "source_was_self": self.obs.is_self(move["from"]),
            "source_army": self.obs.army(move["from"]),
            "source_produces": self._produces(move["from"]),
            "target_was_self": self.obs.is_self(move["to"]),
            "target_army": self.obs.army(move["to"]),
            "target_owner": self.obs.owner[move["to"]],
        }

    @staticmethod
    def _production_ticks(start_turn, end_turn):
        """Official city/general production happens on even turns; count even turns in (start, end]."""
        if end_turn <= start_turn:
            return 0
        return max(0, end_turn // 2 - start_turn // 2)

    @staticmethod
    def _land_ticks(start_turn, end_turn):
        """Every owned tile also grows by one every 50 turns; count multiples of 50 in (start, end]."""
        if end_turn <= start_turn:
            return 0
        return max(0, end_turn // 50 - start_turn // 50)

    # ---------------------------------------------------------------- intent
    def _release_task(self):
        self.task = None

    def _release(self):
        self.task = None
        self.completed_revision = None

    def _resolve_intent(self, strategy, gamemap):
        if not strategy:
            self._release()
            return None
        last_revision = strategy.get("lastRevision") or 0
        active = strategy.get("active")
        status = strategy.get("status", "autonomous")
        if active and (active.get("gameId") != self.game_id
                       or int(active.get("controlEpoch", -1)) != self.epoch):
            self._release()
            return None
        self.last_revision = max(self.last_revision, int(last_revision))
        if not active:
            self._release()
            return None
        revision = active.get("revision")
        if not isinstance(revision, int) or revision < 1:
            self._release()
            return None
        if revision < self.active_revision or revision < self.last_revision:
            self._release()
            return None
        if revision > self.active_revision:
            self._release_task()
            self.completed_revision = None
            self.active_revision = revision
        based_on = active.get("basedOnTurn")
        expires = active.get("expiresTurn")
        if not isinstance(based_on, int) or not isinstance(expires, int):
            self._release()
            return None
        if based_on > gamemap.turn:
            self._release()
            return None
        if expires <= gamemap.turn:
            self._release()
            return None
        if status in ("expired", "cancelled", "invalidated", "stopped"):
            self._release()
            return None
        if self.completed_revision == revision and status != "completed":
            status = "completed"
        goal = active.get("goal") or {}
        if goal.get("kind") not in SUPPORTED_GOALS:
            return {"active": active, "status": status, "revision": revision, "goal": goal,
                    "constraints": Constraints(), "preferences": None,
                    "unsupported": "unsupported_goal:" + str(goal.get("kind"))}
        constraints = self._parse_constraints(active)
        preferences = _parse_preferences(active)
        if isinstance(preferences, dict) and preferences.get("unsupported"):
            return {"active": active, "status": status, "revision": revision, "goal": goal,
                    "constraints": constraints, "preferences": None,
                    "unsupported": preferences["unsupported"]}
        return {"active": active, "status": status, "revision": revision, "goal": goal,
                "constraints": constraints, "preferences": preferences}

    def _parse_constraints(self, active):
        constraints = Constraints()
        raw = active.get("constraints") or {}
        for point in raw.get("avoidTiles") or []:
            try:
                x, y = int(point["x"]), int(point["y"])
            except (KeyError, TypeError, ValueError):
                continue
            if 0 <= x < self.width and 0 <= y < self.height:
                constraints.avoid.add(y * self.width + x)
        for reserve in raw.get("reserves") or []:
            try:
                point = reserve["tile"]
                x, y = int(point["x"]), int(point["y"])
                armies = int(reserve["armies"])
            except (KeyError, TypeError, ValueError):
                continue
            if 0 <= x < self.width and 0 <= y < self.height:
                constraints.reserves[y * self.width + x] = max(0, armies)
        return constraints

    # ---------------------------------------------------------------- pending
    def _verify_pending(self, revision):
        task = self.task
        if not task or not task.get("pending"):
            return
        pending = task["pending"]
        obs = self.obs
        if pending["turn"] >= obs.turn:
            return
        if pending["revision"] is not None and revision is not None and revision <= pending["revision"]:
            return
        confirmed = False
        executed_attack = False
        reason = "step_not_confirmed"
        ticks = self._production_ticks(pending["turn"], obs.turn)
        land = self._land_ticks(pending["turn"], obs.turn) if pending["source_was_self"] else 0
        # Source upper bound: it can only lose the sent armies and gain at most one per official
        # city/general production tick plus one per 50-turn land growth tick.
        source_expected = pending["source_army"] - pending["sent"] + (
            ticks if pending["source_produces"] else 0) + land
        source_paid = (not obs.is_self(pending["from"])) or obs.army(pending["from"]) <= source_expected
        if pending["target_was_self"]:
            # Ownership alone cannot prove a move into our own tile. Require the minimum certain
            # arrival (before + sent), with no production assumed on the destination; any real
            # production only makes the observed army larger.
            expected = pending["target_army"] + pending["sent"]
            if obs.is_self(pending["to"]) and obs.army(pending["to"]) >= expected and source_paid:
                confirmed = True
            else:
                reason = "own_destination_army_missing"
        else:
            if obs.is_self(pending["to"]) and obs.army(pending["to"]) >= 1 and source_paid:
                confirmed = True
            elif source_paid and obs.is_visible(pending["to"]) and not obs.is_self(pending["to"]) \
                    and obs.army(pending["to"]) < pending["target_army"]:
                # A legal weakening attack lands but does not take the tile. It is an executed
                # step, not a capture and never a main migration.
                executed_attack = True
            else:
                reason = "destination_not_owned"
        if executed_attack:
            task["last_rejected"] = None
            task["last_attack"] = {"turn": obs.turn, "from": pending["from"], "to": pending["to"],
                                   "sent": pending["sent"], "before": pending["target_army"],
                                   "after": obs.army(pending["to"])}
            task["pending"] = None
            return
        if confirmed:
            if task.get("main") == pending["from"]:
                task["main"] = pending["to"]
            transport = task.get("transport")
            if transport and pending["from"] == transport.get("source"):
                transport["source"] = pending["to"]
                if pending["to"] == transport.get("target"):
                    task["transport"] = None
            task["last_rejected"] = None
        else:
            task["last_rejected"] = reason
            transport = task.get("transport")
            if transport and pending["from"] == transport.get("source"):
                task["transport"] = None
            self.last_rejected_step = {"turn": obs.turn, "from": pending["from"],
                                       "to": pending["to"], "reason": reason}
        task["pending"] = None

    # ---------------------------------------------------------------- task state
    def _ensure_task(self, intent, gamemap):
        goal = intent["goal"]
        kind = goal.get("kind")
        if kind == "auto":
            self.task = None
            return
        mapped = {"capture_city": "capture_city", "gather": "gather", "defend": "defend",
                  "scout": "scout", "attack_general": "capture_general", "expand": "expand"}[kind]
        target = None
        if "target" in goal:
            target = int(goal["target"]["y"]) * self.width + int(goal["target"]["x"])
        player = goal.get("player") if kind == "attack_general" else None
        if (self.task and self.task["revision"] == intent["revision"] and self.task["kind"] == mapped
                and self.task["target"] == target and self.task["player"] == player):
            return
        if mapped in ("gather", "defend"):
            main = self._best_gather_source(gamemap, target, intent["constraints"], intent["preferences"])
        else:
            main = self._choose_main(gamemap, mapped, target, intent["constraints"], intent["preferences"])
        self.task = {"revision": intent["revision"], "kind": mapped, "target": target, "player": player,
                     "main": main, "phase": "gather" if mapped in ("gather", "defend") else "advance",
                     "pending": None, "last_rejected": None, "created_turn": gamemap.turn,
                     "transport": None, "route": None}

    def _best_gather_source(self, gamemap, target, constraints, preferences):
        risk = (preferences or {}).get("risk", "normal")
        native = self._native_candidate(gamemap, "gather", target, constraints, risk,
                                        held=(target,) if target is not None else ())
        if native.get("next_move") is not None and native.get("source") is not None:
            return native["source"]
        feasible = None
        conditional = None
        for tile in self._own_tiles(gamemap, 2)[:MAX_PLAN_SOURCES]:
            if self._plan_budget_remaining <= 0:
                break
            source = self._idx(tile)
            if source == target:
                continue
            plan = self._plan_path(gamemap, source, target, constraints, risk,
                                   held=(target,) if target is not None else ())
            if plan["feasible"] and plan["delivered"] is not None:
                score = plan["delivered"] / (1.0 + plan["steps"] * 0.05)
                if feasible is None or score > feasible[0] or (score == feasible[0] and source < feasible[1]):
                    feasible = (score, source)
            elif plan["path"] and plan["conditional"]:
                # The exact delivery cannot be promised across fog; use the source army and route
                # length only as a conditional ordering heuristic, never as confirmed delivery.
                score = self.obs.army(source) / (1.0 + plan["steps"] * 0.05)
                if conditional is None or score > conditional[0] or (
                        score == conditional[0] and source < conditional[1]):
                    conditional = (score, source)
        chosen = feasible or conditional
        return chosen[1] if chosen else None

    def _choose_main(self, gamemap, kind, target, constraints, preferences):
        risk = (preferences or {}).get("risk", "normal")
        if kind in ("capture_city", "scout", "capture_general") and target is not None:
            native = self._native_candidate(gamemap, kind, target, constraints, risk)
            if native.get("next_move") is not None and native.get("source") is not None:
                return native["source"]
            raw = native.get("raw_native_move")
            if native.get("source") is not None and raw and native.get("raw_constraints_ok") \
                    and raw.get("from") == native.get("source") \
                    and native.get("reason") in ("constraint_or_force_block",
                                                 "first_unowned_not_capturable") \
                    and native.get("path"):
                # The native front is valid but cannot yet take the first enemy. Keep that front
                # as the task main; donor supply belongs to internal transport, not a new main.
                return native["source"]
        for tile in self._own_tiles(gamemap, 2)[:MAX_PLAN_SOURCES]:
            if self._plan_budget_remaining <= 0:
                break
            index = self._idx(tile)
            if target is not None and index == target:
                continue
            if kind in ("capture_city", "scout", "capture_general") and target is not None:
                plan = self._plan_path(gamemap, index, target, constraints, risk,
                                       allow_fog_target=(kind in ("scout", "capture_general")
                                                         and not self.obs.is_visible(target)
                                                         and risk != "low"))
                if self.obs.is_visible(target):
                    if not plan["feasible"]:
                        continue
                elif not (plan["feasible"] or plan["conditional"]):
                    continue
            return index
        return None

    def _ensure_main(self, gamemap, intent):
        task = self.task
        if task.get("pending"):
            return task["main"]
        if task["main"] is not None:
            index = task["main"]
            if self.obs.is_self(index) and self.obs.army(index) >= 2:
                return index
        if task["kind"] in ("gather", "defend"):
            task["main"] = self._best_gather_source(gamemap, task["target"],
                                                    intent["constraints"], intent["preferences"])
        else:
            task["main"] = self._choose_main(gamemap, task["kind"], task["target"],
                                             intent["constraints"], intent["preferences"])
        return task["main"]

    def _allocated(self, task):
        if task is None or task["kind"] == "expand":
            return set()
        allocated = set()
        if task.get("main") is not None:
            allocated.add(task["main"])
        if task.get("target") is not None and task["kind"] in ("gather", "defend"):
            allocated.add(task["target"])
        transport = task.get("transport")
        if transport:
            for index in transport.get("path") or []:
                allocated.add(index)
            if transport.get("source") is not None:
                allocated.add(transport["source"])
            if transport.get("target") is not None:
                allocated.add(transport["target"])
        route = task.get("route")
        if route:
            for index in route.get("path") or []:
                allocated.add(index)
        return allocated

    def _held(self, task):
        if task and task["kind"] in ("gather", "defend") and task["target"] is not None:
            return {task["target"]}
        return set()

    # ---------------------------------------------------------------- completion
    def _goal_completed(self, task):
        obs = self.obs
        kind = task["kind"]
        if kind == "capture_city":
            return obs.is_visible(task["target"]) and task["target"] in obs.cities and obs.is_self(task["target"])
        if kind == "scout":
            return obs.is_visible(task["target"])
        if kind == "capture_general":
            player = task["player"]
            if obs.dead(player):
                return True
            general = obs.generals[player] if player is not None and player < len(obs.generals) else -1
            return general >= 0 and obs.is_self(general)
        return False

    # ---------------------------------------------------------------- preemption
    def _reachable_steps(self, gamemap, source, target, limit):
        """Shortest known-passable 4-neighbour path length, or None when walls block it."""
        if source == target:
            return 0
        frontier = [source]
        distance = {source: 0}
        while frontier:
            next_frontier = []
            for current in frontier:
                if distance[current] >= limit:
                    continue
                tile = self._tile(gamemap, current)
                for neighbor in tile.neighbors(includeSwamps=True):
                    index = self._idx(neighbor)
                    if index in distance or not _passable(neighbor):
                        continue
                    distance[index] = distance[current] + 1
                    if index == target:
                        return distance[index]
                    next_frontier.append(index)
            frontier = next_frontier
        return None

    def _defense_demand(self, gamemap):
        """Current-frame defense demand from visible reachable threats."""
        obs = self.obs
        general = obs.generals[self.player_index] if self.player_index < len(obs.generals) else -1
        if general < 0 or not obs.is_visible(general) or not obs.is_self(general):
            return None
        config = gamemap.config
        radius = config.defend_general_radius
        margin = config.defend_general_margin
        max_share = config.defend_general_max_share
        threat, distance = 0, None
        for index in range(obs.n):
            if not obs.is_visible(index) or obs.owner[index] is None:
                continue
            if obs.owner[index] == self.player_index:
                continue
            if index in obs.cities or index in obs.generals:
                continue
            steps = self._reachable_steps(gamemap, index, general, radius)
            if steps is None or steps > radius:
                continue
            if obs.army(index) > threat or (obs.army(index) == threat and distance is not None
                                            and steps < distance):
                threat, distance = obs.army(index), steps
        if threat <= 0 or distance is None:
            return None
        total = sum(obs.army(i) for i in range(obs.n) if obs.is_self(i))
        needed = threat + margin
        if max_share > 0:
            needed = min(needed, total * max_share)
        if needed <= 0 or distance > EMERGENCY_HORIZON:
            return None
        return {"general": general, "threat": int(threat), "distance": int(distance),
                "needed": needed, "garrison": int(obs.army(general)),
                "rule": "current visible threat reachable through known passable tiles"}

    def _defense_demand_cached(self, gamemap):
        if not self._frame_defense_ready:
            self._frame_defense = self._defense_demand(gamemap)
            self._frame_defense_ready = True
        return self._frame_defense

    def _half_edge_diagnostic(self):
        demand = self._frame_defense
        if demand is None:
            return None
        return {"general": demand["general"], "needed": demand["needed"],
                "threat": demand["threat"], "distance": demand["distance"],
                "edges": sorted(self._frame_half_edges)}

    def _record_city_half(self, move, diagnostics):
        if not move or not move.get("half"):
            return
        if (move["from"], move["to"]) not in self._frame_half_edges:
            return
        demand = self._frame_defense
        if demand is None:
            return
        sent = _half_armies(self.obs.army(move["from"]), True)
        diagnostics["cityHalfApplied"] = {
            "from": move["from"], "to": move["to"],
            "need": demand["needed"], "sent": sent,
            "remaining": self.obs.army(move["from"]) - sent}

    def _apply_half_edges(self, gamemap, constraints):
        demand = self._defense_demand_cached(gamemap)
        self._frame_half_edges = set()
        if demand is not None and demand["needed"] > 0:
            general = demand["general"]
            self._frame_half_edges = {(general, index) for index in self.obs.cities
                                      if self.obs.is_self(index)}
            constraints.half_edges = set(self._frame_half_edges)
        return demand

    def _emergency_evidence(self, gamemap):
        demand = self._defense_demand_cached(gamemap)
        if demand is None:
            return None
        if self.obs.army(demand["general"]) > demand["needed"]:
            return None
        return {"general": demand["general"], "threat": demand["threat"],
                "distance": demand["distance"], "needed": int(demand["needed"]),
                "garrison": demand["garrison"], "reachable": True,
                "rule": "current visible threat reachable through known passable tiles; garrison short"}

    def _defend_preemption(self, gamemap, constraints, held, risk):
        source, destination = bot_moves.move_defend_general(gamemap)
        if not source or not destination:
            return None
        return self._choose_move(gamemap, self._idx(source), self._idx(destination), constraints, held, risk)

    def _one_step_capture(self, gamemap, constraints, held, risk):
        obs = self.obs
        generals = set(obs.generals)
        for source in self._own_tiles(gamemap, 2):
            source_index = self._idx(source)
            if source_index in held:
                continue
            for neighbor in source.neighbors(includeSwamps=True):
                index = self._idx(neighbor)
                if not obs.is_visible(index) or index not in generals:
                    continue
                owner = obs.owner[index]
                if owner is None or owner == self.player_index:
                    continue
                move, sent = self._capture_move(gamemap, source_index, index, index, constraints, held,
                                                risk)
                if move:
                    return move, {"player": int(owner), "general": index,
                                  "source": source_index, "sent": int(sent)}
        return None

    def _preempt(self, gamemap, constraints, held, risk):
        evidence = self._emergency_evidence(gamemap)
        if evidence:
            move = self._defend_preemption(gamemap, constraints, held, risk)
            if move and move.get("from") == evidence["general"]:
                move = None
            if move:
                if self.task and self.task.get("main") == move["from"]:
                    self.task["pending"] = self._make_pending(move, self._revision)
                return {"status": "preempted", "move": move, "evidence": evidence,
                        "reason": "emergency_general_defense;threat=%d;distance=%d;needed=%d;garrison=%d"
                                  % (evidence["threat"], evidence["distance"], evidence["needed"], evidence["garrison"])}
            return {"status": "denied", "evidence": evidence,
                    "reason": "preemption_denied_constraint;emergency_general_defense"}
        capture = self._one_step_capture(gamemap, constraints, held, risk)
        if capture:
            move, detail = capture
            if self.task and self.task.get("main") == move["from"]:
                self.task["pending"] = self._make_pending(move, self._revision)
            return {"status": "preempted", "move": move, "evidence": detail,
                    "reason": "one_step_general_capture;player=%d;general=%d" % (detail["player"], detail["general"])}
        return None

    # ---------------------------------------------------------------- goal moves
    def _plan_summary(self, plan):
        return {"pathLen": len(plan.get("path") or []), "steps": plan.get("steps", 0),
                "army": plan.get("army"), "delivered": plan.get("delivered"),
                "feasible": bool(plan.get("feasible")), "conditional": bool(plan.get("conditional")),
                "nodes": plan.get("nodes", 0), "reason": plan.get("reason"),
                "boundHit": bool(plan.get("boundHit")), "planMs": plan.get("planMs", 0.0),
                "cached": bool(plan.get("cached"))}

    def _route_candidate_invalid(self, reason):
        return reason in {
            "avoid", "held", "source_not_on_native_path", "native_move_unavailable",
            "native_path_too_short", "not_passable", "route_invalid_wall",
            "route_invalid_adjacency", "native_path_has_no_owned_source",
            "native_source_not_self", "native_source_not_on_path",
            "stale_route_prefix_lost",
        }

    def _route_summary(self):
        route = self.task.get("route") if self.task else None
        if not route:
            return None
        return {"target": route.get("target"), "kind": route.get("kind"),
                "origin": route.get("origin"), "originKind": route.get("originKind"),
                "pathLen": len(route.get("path") or []),
                "updatedTurn": route.get("updatedTurn")}

    def _transport_summary(self, transport):
        return {"role": transport.get("role"), "source": transport.get("source"),
                "origin": transport.get("origin"), "target": transport.get("target"),
                "attackTarget": transport.get("attack_target"),
                "pathLen": len(transport.get("path") or [])}

    def _continue_transport(self, gamemap, target, constraints, held, risk):
        transport = self.task.get("transport")
        if not transport or transport.get("attack_target") != target:
            self.task["transport"] = None
            return None
        source = transport.get("source")
        path = transport.get("path") or []
        if source is None or not self.obs.is_self(source) or self.obs.army(source) < 2 \
                or source not in path:
            self.task["transport"] = None
            return None
        position = path.index(source)
        if position + 1 >= len(path):
            self.task["transport"] = None
            return None
        destination = path[position + 1]
        if destination in constraints.avoid:
            self.task["transport"] = None
            return None
        if destination in held and destination != transport.get("target"):
            self.task["transport"] = None
            return None
        move = self._choose_move(gamemap, source, destination, constraints, held, risk,
                                 require_capture=not self.obs.is_self(destination))
        if not move:
            self.task["transport"] = None
            return None
        self.task["pending"] = self._make_pending(move, self._revision)
        return {"move": move, "phase": "reinforcement_transport",
                "reason": "native_transport_step", "target": target, "mode": "reinforcement_transport",
                "transport": self._transport_summary(transport)}

    def _start_transport(self, gamemap, target, main, constraints, held, risk):
        if main is None or not self.obs.is_self(main):
            return None
        native = self._native_candidate(gamemap, "gather", main, constraints, risk,
                                        held)
        if risk == "low" and native.get("conditional"):
            return None
        if native.get("next_move") is None or native.get("source") is None:
            return None
        route = self.task.get("route")
        if route and native["source"] in (route.get("path") or []) and native["source"] != main:
            return None
        if native["source"] == main or native["source"] in held:
            return None
        transport = {"role": "reinforce_attack", "source": native["source"],
                     "origin": native["source"], "target": main, "attack_target": target,
                     "path": list(native.get("path") or []), "revision": self._revision,
                     "started_turn": self.obs.turn}
        move = native["next_move"]
        if constraints.check(self.obs, gamemap, move, held, risk,
                             require_capture=not self.obs.is_self(move["to"])) is not None:
            return None
        self.task["transport"] = transport
        self.task["pending"] = self._make_pending(move, self._revision)
        return {"move": move, "phase": "reinforcement_transport",
                "reason": "native_transport_start", "target": target,
                "mode": "reinforcement_transport",
                "transport": self._transport_summary(transport)}

    def _native_candidate(self, gamemap, kind, target, constraints, risk, held=(),
                          path_override=None):
        key = (kind, target, risk, tuple(sorted(constraints.avoid)),
               tuple(sorted(constraints.reserves.items())), tuple(sorted(constraints.half_edges)),
               tuple(sorted(held)), tuple(path_override or ()))
        if key not in self._native_cache:
            self._native_cache[key] = build_native_candidate(
                self.obs, gamemap, kind, target, constraints, risk, held,
                path_override=path_override)
        return self._native_cache[key]

    def _native_summary(self, candidate):
        return {"path": list(candidate.get("path") or []),
                "pathLen": len(candidate.get("path") or []),
                "prefixLen": len(candidate.get("prefix") or []),
                "source": candidate.get("source"),
                "next": candidate.get("next_move"),
                "rawProposal": candidate.get("raw_native_move"),
                "nativeMove": candidate.get("native_move"),
                "weakeningAttack": bool(candidate.get("weakeningAttack")),
                "cityHalf": bool(candidate.get("cityHalf")),
                "prefixArmy": candidate.get("prefix_army"),
                "fullArmy": candidate.get("full_army"),
                "departures": list(candidate.get("departures") or []),
                "accounting": list(candidate.get("accounting") or []),
                "fullFeasible": bool(candidate.get("full_feasible")),
                "conditional": bool(candidate.get("conditional")),
                "canStepPath": bool(candidate.get("can_step_path")),
                "reason": candidate.get("reason"),
                "deviation": candidate.get("deviation"),
                "candidateCount": candidate.get("candidateCount", 0),
                "nativeMs": candidate.get("nativeMs", 0.0),
                "accountingSteps": len(candidate.get("accounting") or [])}

    def _capture_toward(self, gamemap, target, constraints, held, preferences):
        risk = (preferences or {}).get("risk", "normal")
        task = self.task
        if task.get("pending"):
            return {"blocked": "awaiting_step_confirmation", "mode": "wait",
                    "evidence": {"main": task.get("main")}}
        continued = self._continue_transport(gamemap, target, constraints, held, risk)
        if continued:
            return continued
        main = self._ensure_main(gamemap, {"constraints": constraints, "preferences": preferences,
                                           "revision": task["revision"]})
        if main is None:
            return {"blocked": "no_goal_source", "mode": "wait", "evidence": {"target": target}}
        route = task.get("route")
        route_path = route.get("path") if route and route.get("target") == target \
            and route.get("kind") == task["kind"] else None
        native = self._native_candidate(gamemap, task["kind"], target, constraints, risk,
                                        held, path_override=route_path)
        if route_path and self._route_candidate_invalid(native.get("reason")):
            task["route"] = None
            route_path = None
            native = self._native_candidate(gamemap, task["kind"], target, constraints,
                                            risk, held)
        native_summary = self._native_summary(native)
        allow_fog = task["kind"] == "capture_general" and not self.obs.is_visible(target) and risk != "low"
        native_move = native.get("next_move")
        if native_move is not None and not (risk == "low" and native.get("conditional")):
            gate = constraints.check(self.obs, gamemap, native_move, held, risk,
                                     allow_fog_target=allow_fog,
                                     require_capture=not self.obs.is_self(native_move["to"])
                                     and not native.get("weakeningAttack"))
            if gate is None:
                task["route"] = {"target": target, "kind": task["kind"],
                                 "path": list(native.get("path") or []),
                                 "origin": native.get("source"), "updatedTurn": self.obs.turn}
                task["main"] = native["source"]
                task["pending"] = self._make_pending(native_move, self._revision)
                return {"move": native_move, "phase": "execute" if native.get("full_feasible")
                        else "advance", "reason": "native_full_feasible"
                        if native.get("full_feasible") else "native_prefix",
                        "target": target, "native": native_summary,
                        "mode": "constraint_fallback" if native.get("departures") else "task_native",
                        "route": self._route_summary(),
                        "prefixFeasible": bool(native.get("prefix") and len(native["prefix"]) > 1),
                        "fullFeasible": bool(native.get("full_feasible"))}
        transported = self._start_transport(gamemap, target, main, constraints, held, risk)
        if transported:
            transported["native"] = native_summary
            return transported
        plan = self._plan_path(gamemap, main, target, constraints, risk, held,
                               allow_fog_target=allow_fog)
        summary = self._plan_summary(plan)
        if not plan["path"] or len(plan["path"]) < 2:
            return {"blocked": "no_goal_route", "mode": "wait",
                    "evidence": {"target": target, "main": main},
                    "plan": summary, "native": native_summary}
        if self.obs.is_visible(target) and not plan["feasible"]:
            return {"blocked": "insufficient_visible_force", "mode": "wait",
                    "evidence": {"target": target, "main": main}, "plan": summary,
                    "native": native_summary}
        path = plan["path"]
        preferred = plan["splits"][0] if plan["splits"] and plan["splits"][0] is not None else None
        move, sent = self._capture_move(gamemap, main, path[1], target, constraints, held, risk,
                                        allow_fog_target=allow_fog, preferred_half=preferred)
        if not move:
            return {"blocked": "no_legal_goal_step", "mode": "wait",
                    "evidence": {"target": target, "main": main},
                    "plan": summary, "native": native_summary}
        task["main"] = path[0]
        task["route"] = {"target": target, "kind": task["kind"],
                         "path": list(path), "origin": path[0],
                         "originKind": "bounded", "updatedTurn": self.obs.turn}
        task["pending"] = self._make_pending(move, self._revision)
        return {"move": move, "phase": "execute" if len(path) == 2 else "advance",
                "reason": "target_step", "target": target, "sent": sent, "plan": summary,
                "native": native_summary, "mode": "task_bounded",
                "route": self._route_summary()}

    def _gather_toward(self, gamemap, target, constraints, held, preferences):
        task = self.task
        risk = (preferences or {}).get("risk", "normal")
        if not self.obs.is_self(target):
            return {"blocked": "target_not_currently_owned", "mode": "wait",
                    "evidence": {"target": target}}
        if task.get("pending"):
            return {"blocked": "awaiting_step_confirmation", "mode": "wait",
                    "evidence": {"main": task.get("main")}}
        route = task.get("route")
        route_path = route.get("path") if route and route.get("target") == target \
            and route.get("kind") == task["kind"] else None
        native = self._native_candidate(gamemap, task["kind"], target, constraints, risk,
                                        held, path_override=route_path)
        if route_path and self._route_candidate_invalid(native.get("reason")):
            task["route"] = None
            route_path = None
            native = self._native_candidate(gamemap, task["kind"], target, constraints,
                                            risk, held)
        native_summary = self._native_summary(native)
        native_move = native.get("next_move")
        if native_move is not None and not (risk == "low" and native.get("conditional")):
            gate = constraints.check(self.obs, gamemap, native_move, held, risk,
                                     require_capture=False)
            if gate is None:
                task["main"] = native["source"]
                task["route"] = {"target": target, "kind": task["kind"],
                                 "path": list(native.get("path") or []),
                                 "origin": native.get("source"), "updatedTurn": self.obs.turn}
                task["pending"] = self._make_pending(native_move, self._revision)
                return {"move": native_move, "phase": "gather",
                        "reason": "native_gather_step", "target": target,
                        "native": native_summary,
                        "mode": "constraint_fallback" if native.get("departures") else "task_native",
                        "route": self._route_summary(),
                        "prefixFeasible": bool(native.get("prefix") and len(native["prefix"]) > 1),
                        "fullFeasible": bool(native.get("full_feasible"))}
        main = task.get("main")
        if main == target:
            main = self._best_gather_source(gamemap, target, constraints, preferences)
            task["main"] = main
        elif main is None or not self.obs.is_self(main) or self.obs.army(main) < 2:
            main = self._best_gather_source(gamemap, target, constraints, preferences)
            task["main"] = main
        if main is None:
            return {"blocked": "no_gather_source", "mode": "wait",
                    "evidence": {"target": target}, "native": native_summary}
        plan = self._plan_path(gamemap, main, target, constraints, risk, held)
        summary = self._plan_summary(plan)
        if not plan["path"] or len(plan["path"]) < 2:
            return {"blocked": "no_gather_route", "mode": "wait",
                    "evidence": {"target": target, "main": main},
                    "plan": summary, "native": native_summary}
        preferred = plan["splits"][0] if plan["splits"] and plan["splits"][0] is not None else None
        move = self._choose_move(gamemap, main, plan["path"][1], constraints, held, risk,
                                 require_capture=not self.obs.is_self(plan["path"][1]),
                                 preferred_half=preferred)
        if not move:
            return {"blocked": "no_legal_gather_step", "mode": "wait",
                    "evidence": {"target": target, "main": main},
                    "plan": summary, "native": native_summary}
        task["main"] = plan["path"][0]
        task["route"] = {"target": target, "kind": task["kind"],
                         "path": list(plan["path"]), "origin": plan["path"][0],
                         "originKind": "bounded", "updatedTurn": self.obs.turn}
        task["pending"] = self._make_pending(move, self._revision)
        return {"move": move, "phase": "gather", "reason": "gather_step", "target": target,
                "plan": summary, "native": native_summary, "mode": "task_bounded",
                "route": self._route_summary()}

    def _scout_toward(self, gamemap, target, constraints, held, preferences):
        risk = (preferences or {}).get("risk", "normal")
        task = self.task
        if task.get("pending"):
            return {"blocked": "awaiting_step_confirmation", "evidence": {"main": task.get("main")}}
        main = self._ensure_main(gamemap, {"constraints": constraints, "preferences": preferences,
                                           "revision": task["revision"]})
        if main is None:
            return {"blocked": "no_scout_source", "mode": "wait", "evidence": {"target": target}}
        route = task.get("route")
        route_path = route.get("path") if route and route.get("target") == target \
            and route.get("kind") == task["kind"] else None
        native = self._native_candidate(gamemap, "scout", target, constraints, risk, held,
                                        path_override=route_path)
        if route_path and self._route_candidate_invalid(native.get("reason")):
            task["route"] = None
            route_path = None
            native = self._native_candidate(gamemap, "scout", target, constraints, risk,
                                            held)
        native_summary = self._native_summary(native)
        native_move = native.get("next_move")
        if native_move is not None and not (risk == "low" and native.get("conditional")):
            gate = constraints.check(self.obs, gamemap, native_move, held, risk,
                                     allow_fog_target=(native_move["to"] == target),
                                     require_capture=not self.obs.is_self(native_move["to"])
                                     and not native.get("weakeningAttack"))
            if gate is None:
                task["main"] = native["source"]
                task["route"] = {"target": target, "kind": "scout",
                                 "path": list(native.get("path") or []),
                                 "origin": native.get("source"), "updatedTurn": self.obs.turn}
                task["pending"] = self._make_pending(native_move, self._revision)
                return {"move": native_move, "phase": "scout", "reason": "native_scout_prefix",
                        "target": target, "native": native_summary,
                        "mode": "constraint_fallback" if native.get("departures") else "task_native",
                        "route": self._route_summary()}
        plan = self._plan_path(gamemap, main, target, constraints, risk, held,
                               allow_fog_target=True)
        summary = self._plan_summary(plan)
        if not plan["path"] or len(plan["path"]) < 2:
            return {"blocked": "no_scout_route", "evidence": {"target": target, "main": main},
                    "plan": summary}
        preferred = plan["splits"][0] if plan["splits"] and plan["splits"][0] is not None else None
        move = self._choose_move(gamemap, main, plan["path"][1], constraints, held, risk,
                                 allow_fog_target=(plan["path"][1] == target),
                                 require_capture=not self.obs.is_self(plan["path"][1]),
                                 preferred_half=preferred)
        if not move:
            return {"blocked": "no_legal_scout_step", "evidence": {"target": target, "main": main},
                    "plan": summary}
        task["main"] = plan["path"][0]
        task["route"] = {"target": target, "kind": "scout",
                         "path": list(plan["path"]), "origin": plan["path"][0],
                         "originKind": "bounded", "updatedTurn": self.obs.turn}
        task["pending"] = self._make_pending(move, self._revision)
        return {"move": move, "phase": "scout", "reason": "scout_step", "target": target,
                "plan": summary, "mode": "task_bounded", "route": self._route_summary()}

    def _attack_toward(self, gamemap, player, constraints, held, preferences):
        obs = self.obs
        if obs.dead(player):
            return {"completed": "target_player_eliminated"}
        general = obs.generals[player] if player < len(obs.generals) else -1
        if general < 0 or not obs.is_visible(general):
            stale = self.known_generals.get(player)
            if stale is None:
                return {"blocked": "target_general_location_unknown", "evidence": {"player": player}}
            if obs.is_visible(stale) and stale not in obs.generals:
                return {"blocked": "target_general_location_stale", "evidence": {"player": player, "tile": stale}}
            general = stale
        if obs.is_self(general):
            return {"completed": "target_general_captured"}
        return self._capture_toward(gamemap, general, constraints, held, preferences)

    # ---------------------------------------------------------------- auto / fallback
    def _source_garrison_locked(self, gamemap, index):
        tile = self._tile(gamemap, index)
        return bool(tile.isGeneral and tile.isSelf()
                    and bot_moves.general_locked(gamemap, gamemap.config))

    def _one_step(self, gamemap, constraints, allocated, held, preferences,
                  respect_garrison=True):
        risk = (preferences or {}).get("risk", "normal")
        emphasis = (preferences or {}).get("emphasis", "balanced")
        best = None
        for source in self._own_tiles(gamemap, 2):
            source_index = self._idx(source)
            if source_index in allocated or source_index in held:
                continue
            if respect_garrison and self._source_garrison_locked(gamemap, source_index):
                continue
            for destination in source.neighbors(includeSwamps=True):
                destination_index = self._idx(destination)
                if self.obs.is_self(destination_index) or destination_index in constraints.avoid:
                    continue
                if not _passable(destination):
                    continue
                if risk == "low" and not self.obs.is_visible(destination_index):
                    continue
                forced_half = (source_index, destination_index) in constraints.half_edges
                for half in (True,) if forced_half else (False, True):
                    sent = _half_armies(self.obs.army(source_index), half)
                    if sent <= 0:
                        continue
                    move = self._move(source_index, destination_index, half)
                    if constraints.check(self.obs, gamemap, move, held, risk,
                                         require_capture=not self.obs.is_self(destination_index)) is not None:
                        continue
                    score = 10 + self.obs.army(source_index) + (self.obs.army(destination_index) == 0 and 5 or 0)
                    if emphasis == "economy" and destination_index in self.obs.cities:
                        score += 30
                    if emphasis == "pressure" and self.obs.owner[destination_index] is not None \
                            and not self.obs.is_self(destination_index):
                        score += 30
                    if emphasis == "pressure" and (destination_index in self.obs.generals
                                                   or destination_index in self.obs.cities):
                        score += 10
                    if emphasis == "information" and any(not self.obs.is_visible(self._idx(t))
                                                         for t in destination.neighbors8()):
                        score += 20
                    if risk == "high" and not self.obs.is_visible(destination_index):
                        score += 10
                    key = (score, -source_index, -destination_index)
                    if best is None or key > best[0]:
                        best = (key, move)
                    break
        return best[1] if best else None

    def _valid_move(self, gamemap, move, constraints, held, risk, allow_fog_target=False):
        return constraints.check(self.obs, gamemap, move, held, risk, allow_fog_target)

    def _auto_move(self, gamemap, constraints, allocated, held, preferences):
        risk = (preferences or {}).get("risk", "normal")
        self.last_auto_rejected = None
        self.last_auto_adjustment = None
        if preferences is not None:
            preferred = self._one_step(gamemap, constraints, allocated, held, preferences)
            if preferred:
                return preferred
        pure = (constraints.empty() and not allocated and not held and preferences is None)
        sink = MoveSink()
        bot_blob.make_move(sink, gamemap)
        if sink.move is not None:
            source, destination, half = sink.move
            move = self._move(self._idx(source), self._idx(destination), half)
            forced_half = (move["from"], move["to"]) in constraints.half_edges
            if forced_half and not half:
                adjusted = self._move(move["from"], move["to"], True)
                rejected = self._valid_move(gamemap, adjusted, constraints, held, risk)
                if not pure and self._source_garrison_locked(gamemap, move["from"]):
                    rejected = rejected or "strategy_general_locked"
                if rejected is None and move["from"] not in allocated:
                    sent = _half_armies(self.obs.army(move["from"]), True)
                    self.last_auto_adjustment = {
                        "rawProposal": dict(move), "finalMove": dict(adjusted),
                        "reason": "city_half_only", "sent": sent,
                        "remaining": self.obs.army(move["from"]) - sent}
                    return adjusted
                failure = rejected or "strategy_allocated_source"
                self.last_auto_rejected = failure
                self.last_auto_adjustment = {
                    "rawProposal": dict(move), "finalMove": None,
                    "reason": "city_half_rejected:" + failure, "rejected": failure}
                if pure:
                    return None
                return self._one_step(gamemap, constraints, allocated, held, preferences,
                                      respect_garrison=True)
            rejected = self._valid_move(gamemap, move, constraints, held, risk)
            if not pure and self._source_garrison_locked(gamemap, move["from"]):
                rejected = rejected or "strategy_general_locked"
            if rejected is None and move["from"] not in allocated:
                return move
            self.last_auto_rejected = rejected or "strategy_allocated_source"
            if pure:
                return self._one_step(gamemap, constraints, allocated, held, preferences,
                                      respect_garrison=False)
        if pure:
            # No intent and no constraints: the pinned blob's wait is the decision. Falling back
            # here would break same-seed equivalence on legal input.
            return None
        return self._one_step(gamemap, constraints, allocated, held, preferences,
                              respect_garrison=True)

    # ---------------------------------------------------------------- main entry
    def step(self, gamemap, observation, context=None, strategy=None):
        started = time.perf_counter()
        self._plan_budget_remaining = MAX_FRAME_PLAN_NODES
        self._plan_nodes_spent = 0
        self._plan_calls = 0
        self._plan_cache = {}
        self._native_cache = {}
        self.last_auto_rejected = None
        self.last_auto_adjustment = None
        if context and context.get("gameId") and context["gameId"] != self.game_id:
            raise ValueError("context_game_mismatch")
        epoch = int(context.get("controlEpoch", self.epoch)) if context else self.epoch
        candidate = Observation(observation, self.player_index)
        if candidate.player != self.player_index or candidate.width != self.width \
                or candidate.height != self.height:
            raise ValueError("observation_player_or_size_mismatch")
        revision = context.get("revision") if context else None
        if epoch < self.epoch:
            # An older control epoch is an old request, not a new context. Do not reset the
            # backend, do not touch observation memory, and keep the current task/constraints.
            feedback = None
            if strategy and strategy.get("active") and self.task is not None:
                feedback = {"revision": self.active_revision, "status": "blocked",
                            "reason": "old_epoch"}
            diagnostics = {"epoch": self.epoch, "requestedEpoch": epoch, "turn": candidate.turn,
                           "activeRevision": self.active_revision, "contextRevision": revision,
                           "oldEpoch": True, "sameFrame": False, "staleContext": False,
                           "knownGenerals": dict(self.known_generals),
                           "lastRejectedStep": self.last_rejected_step}
            return self._response(started, None, feedback, self._task_payload("blocked"), diagnostics)
        if epoch > self.epoch:
            self.epoch = epoch
            self._release()
            self.active_revision = 0
            self.last_revision = 0
            self.completed_revision = None
            self.context_revision = None
            self.last_obs_turn = None
            self.known_generals = {}
        turn_regression = self.last_obs_turn is not None and candidate.turn < self.last_obs_turn
        turn_repeat = self.last_obs_turn is not None and candidate.turn == self.last_obs_turn
        stale_context = bool(turn_regression)
        same_frame = bool(turn_repeat and not stale_context)
        if revision is not None:
            if self.context_revision is not None and revision < self.context_revision:
                stale_context = True
            elif self.context_revision is not None and revision == self.context_revision and not turn_repeat:
                stale_context = True
        if stale_context:
            # A stale/regressing request must not execute or clear a valid task. Return a null
            # action and keep the task and its hard constraints for the next valid frame.
            feedback = None
            if strategy and strategy.get("active") and self.task is not None:
                feedback = {"revision": self.active_revision, "status": "blocked", "reason": "stale_context"}
            diagnostics = {"epoch": epoch, "turn": candidate.turn, "activeRevision": self.active_revision,
                           "contextRevision": revision, "sameFrame": same_frame, "staleContext": True,
                           "knownGenerals": dict(self.known_generals),
                           "lastRejectedStep": self.last_rejected_step}
            return self._response(started, None, feedback, self._task_payload("blocked"), diagnostics)
        # Commit observation memory only for a frame that passed game/epoch/context checks.
        self.obs = candidate
        self._frame_defense = None
        self._frame_defense_ready = False
        self._frame_half_edges = set()
        self.turn = candidate.turn
        for player, index in enumerate(candidate.generals):
            if index >= 0 and candidate.is_visible(index):
                self.known_generals[player] = index
        self.last_obs_turn = candidate.turn
        if revision is not None and (self.context_revision is None or revision > self.context_revision):
            self.context_revision = revision
        self._revision = revision
        intent = self._resolve_intent(strategy, gamemap)
        if not same_frame:
            self._verify_pending(revision)
        diagnostics = {"epoch": epoch, "turn": self.obs.turn, "activeRevision": self.active_revision,
                       "contextRevision": revision, "sameFrame": same_frame, "staleContext": False,
                       "knownGenerals": dict(self.known_generals), "lastRejectedStep": self.last_rejected_step}
        if intent is None:
            constraints = Constraints()
            self._apply_half_edges(gamemap, constraints)
            move = self._auto_move(gamemap, constraints, set(), set(), None)
            diagnostics["mode"] = "native_auto"
            diagnostics["cityHalf"] = self._half_edge_diagnostic()
            return self._response(started, move, None, self._task_payload("auto"), diagnostics)
        if intent.get("unsupported"):
            self._apply_half_edges(gamemap, intent["constraints"])
            move = self._auto_move(gamemap, intent["constraints"], set(), set(), None)
            feedback = {"revision": intent["revision"], "status": "blocked", "reason": intent["unsupported"]}
            diagnostics["mode"] = "constraint_fallback"
            diagnostics["cityHalf"] = self._half_edge_diagnostic()
            return self._response(started, move, feedback, self._task_payload("blocked"), diagnostics)
        constraints = intent["constraints"]
        self._apply_half_edges(gamemap, constraints)
        preferences = intent["preferences"]
        diagnostics["constraints"] = {"avoidTiles": sorted(constraints.avoid),
                                      "reserves": dict(constraints.reserves)}
        diagnostics["cityHalf"] = self._half_edge_diagnostic()
        diagnostics["preferences"] = preferences
        if intent["status"] == "completed":
            move = self._auto_move(gamemap, constraints, set(), set(), preferences)
            diagnostics["mode"] = "completed_auto" if move else "task_native"
            feedback = {"revision": intent["revision"], "status": "completed", "reason": "goal_observed_complete"}
            task = {"kind": intent["goal"].get("kind"), "target": self._goal_target(intent["goal"]),
                    "phase": "completed", "mainTile": None, "allocatedTiles": []}
            return self._response(started, move, feedback, task, diagnostics)
        if same_frame and self.task and self.task.get("pending"):
            feedback = {"revision": intent["revision"], "status": "following", "reason": "replayed_frame"}
            diagnostics["mode"] = "replayed_pending"
            return self._response(started, dict(self.task["pending"]["move"]), feedback,
                                  self._task_payload(self.task["phase"]), diagnostics)
        self._ensure_task(intent, gamemap)
        if self.task is None:
            move = self._auto_move(gamemap, constraints, set(), set(), preferences)
            feedback = {"revision": intent["revision"], "status": "following", "reason": "auto_with_constraints"}
            diagnostics["mode"] = "constraint_fallback"
            return self._response(started, move, feedback, self._task_payload("auto"), diagnostics)
        self._ensure_main(gamemap, intent)
        if self._goal_completed(self.task):
            self.completed_revision = intent["revision"]
            task = self.task
            self._release_task()
            move = self._auto_move(gamemap, constraints, set(), set(), preferences)
            diagnostics["mode"] = "completed_auto" if move else "task_native"
            feedback = {"revision": intent["revision"], "status": "completed",
                        "reason": "goal_observed_complete:" + task["kind"]}
            return self._response(started, move, feedback,
                                  {"kind": task["kind"], "target": task["target"], "phase": "completed",
                                   "mainTile": task.get("main"), "allocatedTiles": sorted(self._allocated(task))},
                                  diagnostics)
        held = self._held(self.task)
        if held:
            diagnostics["held"] = sorted(held)
        risk = (preferences or {}).get("risk", "normal")
        preemption = self._preempt(gamemap, constraints, held, risk)
        if preemption and preemption.get("move"):
            diagnostics["preemption"] = preemption
            diagnostics["mode"] = "emergency"
            feedback = {"revision": intent["revision"], "status": "preempted", "reason": preemption["reason"]}
            return self._response(started, preemption["move"], feedback, self._task_payload("preempted"), diagnostics)
        if preemption and preemption.get("status") == "denied":
            diagnostics["preemptionDenied"] = preemption
        result = self._execute_task(gamemap, intent, constraints, held, preferences)
        diagnostics["taskResult"] = result
        if result.get("native"):
            diagnostics["nativeProposal"] = result["native"].get("rawProposal")
            diagnostics["nativeFinalCandidate"] = result["native"].get("next")
            diagnostics["nativePath"] = result["native"].get("path")
        if result.get("move"):
            diagnostics["finalMove"] = result["move"]
            diagnostics["departure"] = result.get("reason")
        if result.get("completed"):
            self.completed_revision = intent["revision"]
            task = self.task
            self._release_task()
            move = self._auto_move(gamemap, constraints, set(), set(), preferences)
            diagnostics["mode"] = "completed_auto" if move else "task_native"
            feedback = {"revision": intent["revision"], "status": "completed", "reason": result["completed"]}
            return self._response(started, move, feedback,
                                  {"kind": task["kind"], "target": task["target"], "phase": "completed",
                                   "mainTile": task.get("main"), "allocatedTiles": sorted(self._allocated(task))},
                                  diagnostics)
        if result.get("move"):
            self.task["phase"] = result.get("phase", self.task["phase"])
            diagnostics["mode"] = result.get("mode", "task_native")
            feedback = {"revision": intent["revision"], "status": "following",
                        "reason": "goal:%s;revision:%d;phase:%s;%s"
                                  % (self.task["kind"], intent["revision"], self.task["phase"],
                                     result.get("reason", "step"))}
            return self._response(started, result["move"], feedback, self._task_payload(self.task["phase"]),
                                  diagnostics)
        allocated = self._allocated(self.task)
        move = self._auto_move(gamemap, constraints, allocated, held, preferences)
        diagnostics["mode"] = "constraint_fallback" if move else result.get("mode", "wait")
        if not move and held and diagnostics["mode"] == "wait":
            diagnostics["mode"] = "hold"
        if move:
            diagnostics["fallbackMove"] = move
        feedback = {"revision": intent["revision"], "status": "blocked",
                    "reason": "goal:%s;blocked:%s" % (self.task["kind"], result.get("blocked", "no_step"))}
        return self._response(started, move, feedback, self._task_payload("blocked"), diagnostics)

    def _execute_task(self, gamemap, intent, constraints, held, preferences):
        task = self.task
        kind = task["kind"]
        if kind == "capture_city":
            target = task["target"]
            if self.obs.is_visible(target) and target not in self.obs.cities:
                return {"blocked": "target_is_not_a_current_city", "evidence": {"target": target}}
            return self._capture_toward(gamemap, target, constraints, held, preferences)
        if kind in ("gather", "defend"):
            return self._gather_toward(gamemap, task["target"], constraints, held, preferences)
        if kind == "scout":
            return self._scout_toward(gamemap, task["target"], constraints, held, preferences)
        if kind == "capture_general":
            return self._attack_toward(gamemap, task["player"], constraints, held, preferences)
        if kind == "expand":
            if task.get("pending"):
                return {"blocked": "awaiting_step_confirmation", "evidence": {"main": task.get("main")}}
            move = self._one_step(gamemap, constraints, set(), held, preferences)
            if move:
                task["main"] = move["from"]
                task["pending"] = self._make_pending(move, self._revision)
                return {"move": move, "phase": "expand", "reason": "expand_step",
                        "mode": "task_bounded"}
            return {"blocked": "no_expand_step", "mode": "wait",
                    "evidence": {"main": task.get("main")}}
        return {"blocked": "unsupported_task", "mode": "wait"}

    def _goal_target(self, goal):
        if "target" not in goal:
            return None
        return int(goal["target"]["y"]) * self.width + int(goal["target"]["x"])

    def _task_payload(self, phase):
        if self.task is None:
            return {"kind": "auto", "target": None, "phase": phase, "mainTile": None, "allocatedTiles": []}
        return {"kind": self.task["kind"], "target": self.task["target"], "phase": phase,
                "mainTile": self.task.get("main"), "allocatedTiles": sorted(self._allocated(self.task)),
                "route": self._route_summary()}

    def _response(self, started, move, feedback, task, diagnostics):
        self._record_city_half(move, diagnostics)
        if self.last_auto_adjustment and "autoAdjustment" not in diagnostics:
            diagnostics["autoAdjustment"] = self.last_auto_adjustment
        if self.last_auto_rejected and "autoRejected" not in diagnostics:
            diagnostics["autoRejected"] = self.last_auto_rejected
        diagnostics["planning"] = {
            "nodesSpent": self._plan_nodes_spent,
            "calls": self._plan_calls,
            "remaining": self._plan_budget_remaining,
            "frameBudget": MAX_FRAME_PLAN_NODES,
        }
        return {"move": move, "computeMs": round((time.perf_counter() - started) * 1000.0, 3),
                "strategyFeedback": feedback, "task": task, "diagnostics": diagnostics}
