"""Native Harris candidate entrance for fixed-target S2 tasks.

This module maps the pinned Harris path machinery to a small, directly testable candidate:
``best_gather_path``/``path_to`` propose a route and middle source, ``move_path`` or
``move_gather_step`` proposes the native next move, and the exact current-observation model
re-checks split, reserve, pickup and combat. It does not monkeypatch Harris and does not own
task lifecycle or fallback.
"""
from __future__ import annotations

import time

from harris_env import bot_moves

DIRECTIONS = ((0, 1), (0, -1), (1, 0), (-1, 0))
NATIVE_MAX_CANDIDATES = 12


def _index(tile, width):
    return tile.y * width + tile.x


def _half(army, half):
    return army // 2 if half else army - 1


def _reserve(constraints, index):
    return max(1, int(constraints.reserves.get(index, 1)))


def _tile_at(gamemap, index):
    return gamemap.grid[index // gamemap.cols][index % gamemap.cols]


def _candidate_sources(gamemap, obs):
    sources = []
    for index in range(obs.n):
        if obs.is_self(index) and obs.army(index) >= 2:
            sources.append(_tile_at(gamemap, index))
    sources.sort(key=lambda tile: (-obs.army(_index(tile, gamemap.cols)),
                                   _index(tile, gamemap.cols)))
    return sources[:NATIVE_MAX_CANDIDATES]


def _native_path(gamemap, sources, target_tile, kind):
    if not sources:
        return None
    if kind in ("capture_city", "capture_general", "scout"):
        # Pinned native largest-source behavior, including the 0.5 general discount.
        include = 0.5 if not bot_moves.general_locked(gamemap, gamemap.config) else False
        source = gamemap.find_largest_tile(includeGeneral=include)
        if source is None or not source.isSelf():
            source = sources[0]
        return source.path_to(target_tile, includeCities=False)
    # Native gather scoring for fixed gather/reinforcement destination. The small helper
    # mirrors best_gather_path but includes our cities, avoiding a detour around a producer.
    best_path = None
    best_score = None
    urgency = bot_moves.gather_urgency(gamemap, gamemap.config)
    for source in sources:
        path = source.path_to(target_tile, includeCities=True)
        if not path or len(path) < 2:
            continue
        score = bot_moves._gather_score(path, target_tile, urgency,
                                        gamemap.config.gather_delay_factor)
        if best_score is None or score > best_score:
            best_score = score
            best_path = path
    return best_path


def _exact_step(obs, constraints, current, dest, army, preferred_half, require_capture):
    """Return (sent, half, arrival, kind) for one exact current-fact step, or None."""
    if army <= 1:
        return None
    if current in constraints.avoid or dest in constraints.avoid:
        return None
    options = []
    order = (False, True)
    if preferred_half is not None:
        order = (preferred_half, not preferred_half)
    if (current, dest) in constraints.half_edges:
        order = (True,)
    for half in order:
        sent = _half(army, half)
        if sent <= 0 or army - sent < _reserve(constraints, current):
            continue
        if obs.is_visible(dest):
            if obs.is_self(dest):
                arrival = obs.army(dest) + sent
            else:
                if sent <= obs.army(dest):
                    if require_capture:
                        continue
                    arrival = 0
                else:
                    arrival = sent - obs.army(dest)
        else:
            arrival = None
        options.append((sent, half, arrival))
    if not options:
        return None
    # Exact task candidate prefers a split that can take a visible non-owned tile.
    sent, half, arrival = options[0]
    return sent, half, arrival


def build_native_candidate(obs, gamemap, kind, target, constraints, risk, held=(),
                           path_override=None):
    """Build a native fixed-target candidate and exact prefix/full accounting.

    The returned fields are intentionally plain JSON values so diagnostics and tests can
    compare them without a second abstraction.
    """
    target_tile = _tile_at(gamemap, target)
    started = time.perf_counter()
    sources = _candidate_sources(gamemap, obs)
    if path_override:
        path = [_tile_at(gamemap, index) for index in path_override]
    else:
        path = _native_path(gamemap, sources, target_tile, kind)
    result = {
        "kind": kind, "target": target, "path": [], "native_move": None, "next_move": None,
        "raw_native_move": None, "departures": [], "weakeningAttack": False,
        "raw_constraints_ok": False, "cityHalf": False, "source": None,
        "source_index": None,
        "prefix": [], "prefix_end": None,
        "prefix_army": None, "full_feasible": False, "full_army": None,
        "conditional": False, "can_step_path": False, "accounting": [],
        "constraints_ok": False, "deviation": None, "reason": "no_native_path",
        "native_path_missing": path is None, "candidateCount": len(sources),
    }
    if not path or len(path) < 2:
        result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
        return result
    # A saved route can retain a prefix that has since fallen to the enemy or fog. The current
    # owned suffix is the only valid starting route; do not simulate force from a non-owned source.
    if path and not obs.is_self(_index(path[0], gamemap.cols)):
        own_positions = [i for i, tile in enumerate(path)
                         if obs.is_self(_index(tile, gamemap.cols))]
        if not own_positions:
            result["reason"] = "native_path_has_no_owned_source"
            result["deviation"] = "stale_route_prefix_lost"
            result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
            return result
        path = path[own_positions[0]:]
        result["deviation"] = "stale_route_prefix_trimmed"
        result["departures"].append("stale_route_prefix_trimmed")
        if len(path) < 2:
            result["reason"] = "native_path_too_short"
            result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
            return result
    result["path"] = [_index(tile, gamemap.cols) for tile in path]
    result["can_step_path"] = bool(gamemap.canStepPath(path))
    for left, right in zip(result["path"], result["path"][1:]):
        lx, ly = left % gamemap.cols, left // gamemap.cols
        rx, ry = right % gamemap.cols, right // gamemap.cols
        if abs(lx - rx) + abs(ly - ry) != 1:
            result["reason"] = "route_invalid_adjacency"
            result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
            return result
        tile = _tile_at(gamemap, right)
        if tile.tile == -2 or (tile.tile == -4 and not (tile.isCity or tile.isGeneral)):
            result["reason"] = "route_invalid_wall"
            result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
            return result
    if kind in ("gather", "defend"):
        native_from, native_to = bot_moves.move_gather_step(path, gamemap, gamemap.config)
    else:
        native_from, native_to = bot_moves.move_path(path, gamemap, gamemap.config)
    if not native_from or not native_to:
        result["reason"] = "native_move_unavailable"
        return result
    raw_from = _index(native_from, gamemap.cols)
    raw_to = _index(native_to, gamemap.cols)
    raw_half = bool(bot_moves.should_move_half(gamemap, native_from, native_to))
    result["raw_native_move"] = {"from": raw_from, "to": raw_to, "half": raw_half}
    result["raw_constraints_ok"] = constraints.check(
        obs, gamemap, result["raw_native_move"], held, risk, allow_fog_target=False,
        require_capture=False) is None
    native_half = raw_half
    native_source = raw_from
    if not obs.is_self(native_source):
        # move_path's reverse capture scan can name an interior tile; a fixed-target prefix
        # still starts from an owned native path source.
        native_from, native_to = bot_moves.move_gather_step(path, gamemap, gamemap.config)
        if not native_from or not native_to:
            result["reason"] = "native_move_unavailable"
            return result
        native_half = bool(bot_moves.should_move_half(gamemap, native_from, native_to))
        result["deviation"] = "native_move_named_non_owned_source"
        result["departures"].append("source_non_owned_to_native_gather_step")
    source = _index(native_from, gamemap.cols)
    if not obs.is_self(source):
        result["reason"] = "native_source_not_self"
        result["deviation"] = "source_not_currently_owned"
        return result
    destination = _index(native_to, gamemap.cols)
    result["native_move"] = {"from": source, "to": destination, "half": native_half}
    result["source"] = source
    if source not in result["path"]:
        result["reason"] = "native_source_not_on_path"
        result["deviation"] = "source_not_on_native_path"
        return result
    position = result["path"].index(source)
    segment = result["path"][position:]
    if len(segment) < 2:
        result["reason"] = "native_path_too_short"
        return result
    if target in constraints.avoid or source in constraints.avoid:
        result["reason"] = "avoid"
        result["deviation"] = "source_or_target_avoided"
        return result
    if any(index in constraints.avoid for index in segment):
        result["reason"] = "avoid"
        result["deviation"] = "native_path_crosses_avoid"
        return result
    if any(index in held and index != target for index in segment):
        result["reason"] = "held"
        result["deviation"] = "native_path_crosses_held"
        return result

    army = obs.army(source)
    current = source
    prefix = [source]
    accounting = []
    conditional = False
    full = False
    next_move = None
    for step_index, dest in enumerate(segment[1:]):
        if dest in constraints.avoid:
            result["reason"] = "avoid"
            break
        if dest in held and dest != target:
            result["reason"] = "held"
            break
        if not obs.is_visible(dest) and risk == "low":
            conditional = True
            result["reason"] = "low_risk_unknown"
            break
        preferred = None
        if step_index == 0:
            preferred = result["native_move"]["half"]
        if step_index == 0 and preferred is True and obs.is_visible(dest) and not obs.is_self(dest):
            raw = result.get("raw_native_move")
            raw_matches = bool(raw and raw.get("from") == source and raw.get("to") == dest
                               and raw.get("half") is True and result.get("can_step_path"))
            raw_gate = False
            if raw_matches:
                raw_gate = constraints.check(obs, gamemap, raw, held, risk,
                                             allow_fog_target=False,
                                             require_capture=False) is None
            full_sent = army - 1 if army > 1 else 0
            full_can_take_first = full_sent > obs.army(dest)
            if raw_matches and raw_gate and full_can_take_first:
                weakening = _exact_step(obs, constraints, current, dest, army, preferred,
                                        require_capture=False)
                if weakening is not None and weakening[0] <= obs.army(dest):
                    sent, half, _ = weakening
                    next_move = {"from": current, "to": dest, "half": half}
                    result["weakeningAttack"] = True
                    accounting.append({"tile": dest, "before": army, "sent": sent,
                                       "half": half, "after": None, "captured": False,
                                       "attack": True, "visible": True,
                                       "target_after": max(0, obs.army(dest) - sent)})
                    result["reason"] = "native_weakening_attack"
                    break
            elif not full_can_take_first or not result.get("can_step_path"):
                result["weakeningGuard"] = "canStepPath_or_full_capability_false"
            elif not raw_matches:
                result["weakeningGuard"] = "raw_proposal_mismatch_or_source_corrected"
            elif not raw_gate:
                result["weakeningGuard"] = "raw_move_hard_constraint"
        split = _exact_step(obs, constraints, current, dest, army, preferred, require_capture=True)
        if split is None:
            result["reason"] = "constraint_or_force_block"
            break
        sent, half, arrival = split
        if step_index == 0 and (current, dest) in constraints.half_edges \
                and preferred is False:
            result["departures"].append("city_half_only")
            result["cityHalf"] = True
        if step_index == 0 and result["native_move"] is not None \
                and half != result["native_move"]["half"]:
            result["departures"].append(
                "half_corrected:%s->%s" % (result["native_move"]["half"], half))
        visible = obs.is_visible(dest)
        if not visible:
            conditional = True
            if risk != "low" and step_index == 0:
                split = _exact_step(obs, constraints, current, dest, army, preferred,
                                    require_capture=False)
                if split is not None:
                    sent, half, _ = split
                    next_move = {"from": current, "to": dest, "half": half}
                    prefix.append(dest)
                    current = dest
                    accounting.append({"tile": dest, "before": army, "sent": sent,
                                       "half": half, "after": None, "captured": None,
                                       "visible": False})
            result["reason"] = "unknown_prefix"
            break
        if not obs.is_self(dest):
            if sent <= obs.army(dest):
                result["reason"] = "first_unowned_not_capturable"
                break
            arrival = sent - obs.army(dest)
        else:
            arrival = obs.army(dest) + sent
        accounting.append({"tile": dest, "before": army, "sent": sent, "half": half,
                           "after": arrival, "captured": not obs.is_self(dest),
                           "visible": True})
        if step_index == 0:
            next_move = {"from": current, "to": dest, "half": half}
        current = dest
        army = arrival
        prefix.append(dest)
        if dest == target:
            full = True
            break

    result["accounting"] = accounting
    result["prefix"] = prefix
    result["prefix_end"] = current
    result["prefix_army"] = army
    result["full_feasible"] = bool(full and not conditional)
    result["full_army"] = army if result["full_feasible"] else None
    result["conditional"] = conditional
    result["constraints_ok"] = next_move is not None
    if next_move is not None:
        # The common final gate is still authoritative for the actual move.
        need_capture = not result.get("weakeningAttack", False)
        reason = constraints.check(obs, gamemap, next_move, held, risk, allow_fog_target=False,
                                   require_capture=need_capture)
        if reason is not None:
            # A reserve/capture correction can use the other split only if exact already allows it.
            other = {"from": next_move["from"], "to": next_move["to"],
                     "half": not next_move["half"]}
            forced_half = (next_move["from"], next_move["to"]) in constraints.half_edges
            if not forced_half and constraints.check(obs, gamemap, other, held, risk,
                                                     allow_fog_target=False,
                                                     require_capture=need_capture) is None:
                next_move = other
            else:
                result["constraints_ok"] = False
                result["reason"] = "final_gate:" + reason
                next_move = None
    result["next_move"] = next_move
    if result["full_feasible"]:
        result["reason"] = "native_full_feasible"
    elif result.get("weakeningAttack") and next_move is not None:
        result["reason"] = "native_weakening_attack"
    elif next_move is not None:
        result["reason"] = "native_prefix"
    elif result["conditional"]:
        result["reason"] = "native_conditional"
    result["nativeMs"] = round((time.perf_counter() - started) * 1000.0, 3)
    return result
