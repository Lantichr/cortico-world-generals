import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim, goal, intent, state


def corridor_board(target_army=30):
    sim = Sim(9, 9, players=2)
    open_tiles = {0, 40, 41, 42, 49, 80}
    for y in range(9):
        for x in range(9):
            index = y * 9 + x
            if index not in open_tiles:
                sim.mountain(x, y)
    sim.tile(0, 0, owner=0, army=2, general=0)
    sim.tile(8, 8, owner=1, army=2, general=1)
    sim.tile(4, 4, owner=0, army=20)
    sim.tile(5, 4, owner=0, army=1)
    sim.tile(6, 4, owner=1, army=target_army, city=True)
    sim.tile(4, 5, owner=0, army=20)
    return sim


class NativePersistentTest(unittest.TestCase):
    def test_same_revision_native_attack_completes_with_middle_source(self):
        sim = corridor_board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        first = h.step(active)
        self.assertEqual(first["strategyFeedback"]["status"], "following")
        self.assertIn(first["task"]["mainTile"], (sim.idx(4, 4), sim.idx(4, 5)))
        self.assertIn(first["move"]["from"], (sim.idx(4, 4), sim.idx(4, 5)))
        self.assertIn("native", first["diagnostics"]["taskResult"])
        for _ in range(8):
            if first["move"]:
                sim.apply_move(0, first["move"])
            else:
                sim.advance()
            if sim.owner[sim.idx(6, 4)] == 0:
                break
            first = h.step(active)
        self.assertEqual(sim.owner[sim.idx(6, 4)], 0)
        self.assertEqual(first["strategyFeedback"]["revision"], 1)

    def test_native_prefix_actually_moves_before_full_target_is_available(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=20)
        sim.tile(0, 1, owner=1, army=12)
        sim.tile(0, 2, owner=1, army=12, city=True)
        sim.tile(1, 2, owner=0, army=2)
        sim.tile(0, 6, owner=0, army=2, general=0)
        sim.mountain(1, 0)
        sim.mountain(1, 1)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (0, 2)), revision=1)))
        self.assertEqual(out["strategyFeedback"]["status"], "following", out)
        self.assertEqual(out["diagnostics"].get("mode"), "task_native", out)
        self.assertEqual(out["move"], {"from": sim.idx(0, 0), "to": sim.idx(0, 1),
                                       "half": False})
        self.assertFalse(out["diagnostics"]["taskResult"]["fullFeasible"])
        sim.apply_move(0, out["move"])
        out = h.step(state(intent(goal("capture_city", (0, 2)), revision=1)))
        self.assertNotEqual(out["strategyFeedback"]["status"], "completed")

    def test_producing_city_uses_short_owned_route(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(8, 8, owner=1, army=2, general=1)
        sim.tile(4, 4, owner=0, army=30)
        sim.tile(5, 4, owner=0, army=2, city=True)
        sim.tile(6, 4, owner=0, army=2)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("gather", (6, 4)), revision=1)))
        self.assertEqual(out["move"], {"from": sim.idx(4, 4), "to": sim.idx(5, 4),
                                       "half": False}, out)
        sim.apply_move(0, out["move"])
        out = h.step(state(intent(goal("gather", (6, 4)), revision=1)))
        self.assertEqual(out["task"]["mainTile"], sim.idx(5, 4))
        self.assertEqual(out["move"]["from"], sim.idx(5, 4))

    def test_fully_lost_route_replans_from_current_main(self):
        sim = Sim(5, 5, players=2)
        for i in (0, 1, 2, 3):
            sim.tile(i % 5, i // 5, owner=1, army=10)
        sim.tile(1, 1, owner=0, army=210)            # current available main
        sim.tile(2, 1, owner=0, army=1)
        sim.tile(3, 1, owner=1, army=30, city=True)
        sim.tile(4, 4, owner=1, army=10, general=1)
        sim.tile(0, 4, owner=0, army=2, general=0)
        h = Harness(sim)
        h.prime()
        h.step()
        backend = h.adapter.backend
        old_path = [0, 1, 2, 3, 8]
        backend.task = {"kind": "capture_city", "target": 8, "revision": 1,
                        "main": 6, "pending": None,
                        "route": {"target": 8, "kind": "capture_city",
                                  "path": old_path, "origin": 0, "updatedTurn": 0}}
        out = backend._capture_toward(h.adapter.game, 8,
                                      backend._parse_constraints({"constraints": {}}), set(), {})
        self.assertIn(out["mode"], ("task_native", "constraint_fallback"), out)
        self.assertNotEqual(out["mode"], "reinforcement_transport", out)
        self.assertEqual(out["move"]["from"], 6, out)
        self.assertEqual(backend.task["route"]["path"], [6, 7, 8])
        self.assertIsNone(backend.task.get("transport"))

    def test_stale_route_prefix_uses_current_front(self):
        from native_candidate import build_native_candidate
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=1, army=10)             # fallen/fogged rear prefix
        sim.tile(0, 1, owner=1, army=10)
        sim.tile(1, 1, owner=0, army=210)            # current front
        sim.tile(2, 1, owner=0, army=1)
        sim.tile(3, 1, owner=1, army=30, city=True)
        sim.tile(0, 4, owner=0, army=2, general=0)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend = h.adapter.backend
        old_path = [sim.idx(0, 0), sim.idx(0, 1), sim.idx(1, 1),
                    sim.idx(2, 1), sim.idx(3, 1)]
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(3, 1), backend._parse_constraints(
                                               {"constraints": {}}), "normal",
                                           path_override=old_path)
        self.assertEqual(candidate["source"], sim.idx(1, 1), candidate)
        self.assertEqual(candidate["path"], old_path[2:], candidate)
        self.assertTrue(candidate["full_feasible"], candidate)
        self.assertIsNotNone(candidate["next_move"], candidate)
        backend.task = {"kind": "capture_city", "target": sim.idx(3, 1), "revision": 1,
                        "main": sim.idx(1, 1), "pending": None,
                        "route": {"target": sim.idx(3, 1), "kind": "capture_city",
                                  "path": old_path, "origin": sim.idx(0, 0),
                                  "updatedTurn": 0}}
        out = backend._capture_toward(h.adapter.game, sim.idx(3, 1),
                                      backend._parse_constraints({"constraints": {}}), set(), {})
        self.assertIn(out["mode"], ("task_native", "constraint_fallback"), out)
        self.assertNotEqual(out["mode"], "reinforcement_transport", out)
        self.assertIsNone(backend.task.get("transport"))
        self.assertNotEqual(out["move"]["from"], sim.idx(0, 0), out)
        self.assertEqual(out["move"]["from"], sim.idx(1, 1), out)
        self.assertEqual(backend.task["route"]["origin"], sim.idx(1, 1))
        self.assertEqual(backend.task["route"]["path"], old_path[2:])

    def test_bounded_fallback_commits_its_actual_path(self):
        sim = Sim(9, 9, players=2)
        sim.tile(4, 4, owner=0, army=30, general=0)  # main 40
        sim.tile(6, 3, owner=0, army=1)               # pickup 33
        sim.tile(6, 4, owner=1, army=12, city=True)   # target 42
        sim.tile(0, 0, owner=0, army=2, city=True)    # reserved home 0
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1,
                              constraints={"avoidTiles": [{"x": 5, "y": 4}],
                                           "reserves": [{"tile": {"x": 0, "y": 0},
                                                         "armies": 2}]}))
        out = h.step(active)
        self.assertEqual(out["diagnostics"]["mode"], "task_bounded", out)
        self.assertEqual(out["task"]["route"]["originKind"], "bounded")
        expected = [sim.idx(4, 4), sim.idx(4, 3), sim.idx(5, 3),
                    sim.idx(6, 3), sim.idx(6, 4)]
        self.assertEqual(h.adapter.backend.task["route"]["path"], expected, out)
        self.assertEqual(out["move"], {"from": sim.idx(4, 4), "to": sim.idx(4, 3),
                                       "half": False}, out)
        sim.apply_move(0, out["move"])
        out = h.step(active)
        self.assertEqual(out["diagnostics"]["mode"], "task_native", out)
        self.assertEqual(out["strategyFeedback"]["revision"], 1)
        self.assertEqual(out["move"]["from"], sim.idx(4, 3), out)
        self.assertEqual(out["move"]["to"], sim.idx(5, 3), out)

    def test_front_main_waits_for_supply_without_marching_back(self):
        sim = corridor_board(target_army=40)
        sim.tile(4, 4, owner=0, army=1)              # behind main
        sim.tile(5, 4, owner=0, army=30)             # front main
        sim.tile(4, 5, owner=0, army=20)             # donor
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        out = h.step(active)
        self.assertEqual(out["task"]["mainTile"], sim.idx(5, 4), out)
        self.assertEqual(out["move"], {"from": sim.idx(4, 5), "to": sim.idx(4, 4),
                                       "half": False}, out)
        self.assertEqual(out["diagnostics"]["mode"], "reinforcement_transport", out)
        self.assertEqual(out["strategyFeedback"]["revision"], 1)
        for _ in range(8):
            sim.apply_move(0, out["move"])
            if sim.owner[sim.idx(6, 4)] == 0:
                break
            out = h.step(active)
        self.assertEqual(sim.owner[sim.idx(6, 4)], 0, out)
        self.assertEqual(out["strategyFeedback"]["revision"], 1)

    def test_weakening_guard_does_not_feed_strong_neutral(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=100, general=0)
        sim.tile(0, 1, owner=None, army=150)             # neutral blocker
        sim.tile(0, 2, owner=1, army=12, city=True)
        sim.tile(8, 8, owner=1, army=2, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (0, 2)), revision=1))
        out = h.step(active)
        if out["move"]:
            self.assertFalse(out["move"]["from"] == sim.idx(0, 0)
                             and out["move"]["to"] == sim.idx(0, 1), out)
        self.assertEqual(out["strategyFeedback"]["revision"], 1)
        self.assertEqual(out["task"]["target"], sim.idx(0, 2))
        self.assertEqual(h.adapter.backend.task["revision"], 1)

    def test_pending_observation_success_moves_main_once(self):
        sim = corridor_board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        first = h.step(active)
        sim.apply_move(0, first["move"])
        second = h.step(active)
        self.assertEqual(second["task"]["mainTile"], first["move"]["to"])
        self.assertEqual(second["strategyFeedback"]["revision"], 1)

    def test_pending_discard_does_not_move_main(self):
        sim = corridor_board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        first = h.step(active)
        main = first["task"]["mainTile"]
        sim.advance()                               # discard the proposal
        second = h.step(active)
        self.assertEqual(second["task"]["mainTile"], main)
        self.assertIsNotNone(second["diagnostics"]["lastRejectedStep"])
        self.assertEqual(second["strategyFeedback"]["revision"], 1)

    def test_route_path_with_new_wall_is_not_full_feasible(self):
        from native_candidate import build_native_candidate
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 1, owner=0, army=1)
        sim.tile(0, 2, owner=1, army=3, city=True)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend = h.adapter.backend
        constraints = backend._parse_constraints({"constraints": {}})
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), constraints, "normal",
                                           path_override=[sim.idx(0, 0), sim.idx(0, 1)])
        sim.mountain(0, 1)
        h.step()                                    # sync discovered map after the new wall
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), constraints, "normal",
                                           path_override=[sim.idx(0, 0), sim.idx(0, 1),
                                                          sim.idx(0, 2)])
        self.assertEqual(candidate["reason"], "route_invalid_wall", candidate)
        self.assertFalse(candidate["full_feasible"], candidate)

    def test_native_attack_path_starts_at_largest_source(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=5)
        sim.tile(0, 1, owner=0, army=30)
        sim.tile(0, 2, owner=1, army=4, general=1)
        sim.tile(0, 4, owner=0, army=2, general=0)
        h = Harness(sim)
        h.prime()
        h.step()
        from native_candidate import build_native_candidate
        candidate = build_native_candidate(h.adapter.backend.obs, h.adapter.game,
                                           "capture_general", sim.idx(0, 2),
                                           h.adapter.backend._parse_constraints({"constraints": {}}),
                                           "normal")
        self.assertEqual(candidate["source"], sim.idx(0, 1), candidate)
        self.assertEqual(candidate["native_move"]["from"], sim.idx(0, 1))

    def test_general_discount_uses_native_field_source_without_v2_cost(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=100, general=0)
        sim.tile(8, 8, owner=1, army=2, general=1)
        sim.tile(4, 4, owner=0, army=60)
        sim.tile(6, 4, owner=1, army=12, city=True)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (6, 4)), revision=1)))
        self.assertEqual(out["move"]["from"], sim.idx(4, 4))
        self.assertEqual(out["diagnostics"]["mode"], "task_native")
        self.assertEqual(out["diagnostics"]["planning"]["nodesSpent"], 0)
        self.assertIn("native", out["diagnostics"]["taskResult"])
        self.assertIsInstance(out["diagnostics"]["nativePath"], list)
        self.assertIn("rawProposal", out["diagnostics"]["taskResult"]["native"])

    def test_recovery_main30_donor20_city40(self):
        sim = corridor_board(target_army=40)
        sim.tile(4, 4, owner=0, army=30)
        sim.tile(4, 5, owner=0, army=20)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        seen = []
        captured = False
        for _ in range(14):
            out = h.step(active)
            if out["move"]:
                seen.append(dict(out["move"]))
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
            if sim.owner[sim.idx(6, 4)] == 0:
                captured = True
                break
        self.assertTrue(captured, out)
        self.assertGreaterEqual(len(seen), 3)
        for left, right in zip(seen, seen[1:]):
            self.assertFalse(left["from"] == right["to"] and left["to"] == right["from"],
                             seen)

    def test_short_front_prefers_donor_supply_over_detour(self):
        sim = corridor_board(target_army=41)
        sim.tile(4, 4, owner=0, army=30)
        sim.tile(4, 5, owner=0, army=20)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        modes = []
        seen = []
        for _ in range(10):
            out = h.step(active)
            modes.append(out["diagnostics"].get("mode"))
            if out["move"]:
                seen.append(dict(out["move"]))
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
            if sim.owner[sim.idx(6, 4)] == 0:
                break
        self.assertTrue(sim.owner[sim.idx(6, 4)] == 0, out)
        self.assertIn("reinforcement_transport", modes, out)
        self.assertEqual(out["strategyFeedback"]["revision"], 1)
        self.assertEqual(len(seen), 4, seen)
        self.assertEqual(seen[1], {"from": sim.idx(4, 5), "to": sim.idx(4, 4),
                                   "half": False}, seen)

    def test_pending_blocks_a_second_step_until_observed(self):
        sim = corridor_board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (6, 4)), revision=1))
        first = h.step(active)
        self.assertIsNotNone(first["move"])
        second = h.step(active)                      # same frame, no execution
        self.assertTrue(second["diagnostics"]["sameFrame"], second)
        self.assertEqual(second["move"], first["move"])
        self.assertEqual(second["task"]["mainTile"], first["task"]["mainTile"])


if __name__ == "__main__":
    unittest.main()
