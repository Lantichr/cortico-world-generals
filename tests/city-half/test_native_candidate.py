import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from native_candidate import build_native_candidate
from sim import Harness, Sim


class NativeCandidateTest(unittest.TestCase):
    def _backend(self, sim):
        h = Harness(sim)
        h.prime()
        h.step()                     # sync the discovered Map to the current raw frame
        return h, h.adapter.backend

    def _constraints(self, backend, reserves=None, avoid=None):
        raw = {}
        if reserves:
            raw["reserves"] = [{"tile": {"x": x, "y": y}, "armies": armies}
                               for (x, y), armies in reserves.items()]
        if avoid:
            raw["avoidTiles"] = [{"x": x, "y": y} for x, y in avoid]
        return backend._parse_constraints({"constraints": raw})

    def test_late_turn_raw_half_matches_native_move_once(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=50, general=0)
        sim.tile(0, 1, owner=0, army=30)
        sim.tile(0, 2, owner=1, army=5, city=True)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        sim.turn = 251
        h.step()
        backend = h.adapter.backend
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertIsNotNone(candidate["raw_native_move"], candidate)
        self.assertEqual(candidate["raw_native_move"]["from"], candidate["source"])
        if candidate["native_move"] is not None:
            self.assertEqual(candidate["native_move"]["from"], candidate["source"])
            self.assertEqual(candidate["native_move"]["half"],
                             candidate["raw_native_move"]["half"])

    def test_native_candidate_is_bounded_and_timed(self):
        sim = Sim(21, 21, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        for i in range(1, 14):
            sim.tile(i, 0, owner=0, army=2 + i)
        sim.tile(20, 20, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(20, 20), self._constraints(backend), "normal")
        self.assertLessEqual(candidate["candidateCount"], 12)
        self.assertLessEqual(len(candidate["path"]), 441)
        self.assertLess(candidate["nativeMs"], 1000.0, candidate)
        for left, right in zip(candidate["path"], candidate["path"][1:]):
            lx, ly = sim.xy(left)
            rx, ry = sim.xy(right)
            self.assertEqual(abs(lx - rx) + abs(ly - ry), 1, candidate["path"])

    def test_native_gather_candidate_reaches_task_diagnostics(self):
        sim = Sim(9, 9, players=2)
        sim.tile(3, 4, owner=0, army=2, city=True)
        sim.tile(4, 4, owner=0, army=30, general=0)
        for x in (5, 6, 7, 8):
            sim.tile(x, 4, owner=0, army=2)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        from sim import goal, intent, state
        out = h.step(state(intent(goal("gather", (8, 4)), revision=1)))
        result = out["diagnostics"]["taskResult"]
        self.assertIn("native", result, out)
        self.assertTrue(result["native"]["fullFeasible"], result)
        self.assertEqual(out["move"]["to"], out["move"]["from"] + 1)
        self.assertIn(out["task"]["mainTile"], (sim.idx(3, 4), sim.idx(4, 4)))

    def test_native_middle_path_source(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=5)                  # path start
        sim.tile(0, 1, owner=0, army=20)                 # native capture source in the middle
        sim.tile(0, 2, owner=1, army=17, city=True)     # becomes 18 at turn 2
        sim.tile(0, 4, owner=0, army=2, general=0)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertEqual(candidate["path"][0], candidate["source"], candidate)
        self.assertEqual(candidate["source"], sim.idx(0, 1), candidate)
        self.assertEqual(candidate["next_move"]["from"], sim.idx(0, 1))
        self.assertIsNotNone(candidate["raw_native_move"])
        self.assertIsNotNone(candidate["full_army"])
        self.assertTrue(candidate["accounting"])
        self.assertTrue(candidate["full_feasible"], candidate)

    def test_native_middle_source_and_pickup_accounting(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=20)
        sim.tile(0, 1, owner=0, army=10)
        sim.tile(0, 2, owner=1, army=24, city=True)
        sim.tile(0, 6, owner=0, army=2, general=0)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertTrue(candidate["full_feasible"], candidate)
        self.assertEqual(candidate["path"][0], sim.idx(0, 0))
        self.assertEqual(candidate["path"], [sim.idx(0, 0), sim.idx(0, 1), sim.idx(0, 2)])
        self.assertEqual(candidate["accounting"][0]["tile"], sim.idx(0, 1))
        self.assertFalse(candidate["accounting"][0]["captured"])
        self.assertTrue(candidate["accounting"][1]["captured"])
        self.assertEqual(candidate["next_move"]["from"], sim.idx(0, 0))

    def test_two_successive_captures_use_simulated_ownership(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=30)
        sim.tile(0, 1, owner=1, army=12)
        sim.tile(0, 2, owner=1, army=11, city=True)     # becomes 12 at turn 2
        sim.tile(1, 2, owner=0, army=2)          # reveal target
        sim.tile(0, 6, owner=0, army=2, general=0)
        sim.mountain(1, 0)
        sim.mountain(1, 1)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertTrue(candidate["full_feasible"], candidate)
        self.assertEqual([step["after"] for step in candidate["accounting"]], [17, 4])
        self.assertEqual(candidate["full_army"], 4)

    def test_prefix_advances_when_full_target_is_not_capturable(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=20)
        sim.tile(0, 1, owner=1, army=12)
        sim.tile(0, 2, owner=1, army=12, city=True)
        sim.tile(1, 2, owner=0, army=2)          # makes the second city visible
        sim.tile(0, 6, owner=0, army=2, general=0)
        sim.mountain(1, 0)
        sim.mountain(1, 1)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertFalse(candidate["full_feasible"], candidate)
        self.assertEqual(candidate["prefix"], [sim.idx(0, 0), sim.idx(0, 1)], candidate)
        self.assertEqual(candidate["next_move"], {"from": sim.idx(0, 0), "to": sim.idx(0, 1),
                                                  "half": False})
        self.assertEqual(candidate["accounting"][0]["after"], 7)   # 19 sent - 12 defenders

    def test_reserve_and_avoid_block_candidate(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=50)
        sim.tile(0, 1, owner=1, army=23, city=True)
        sim.tile(0, 4, owner=0, army=2, general=0)
        sim.mountain(1, 0)
        sim.mountain(1, 1)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        reserved = build_native_candidate(
            backend.obs, h.adapter.game, "capture_city", sim.idx(0, 1),
            self._constraints(backend, reserves={(0, 0): 10}), "normal")
        self.assertTrue(reserved["next_move"]["half"], reserved)
        self.assertEqual(reserved["accounting"][0]["sent"], 25)

        avoided = build_native_candidate(
            backend.obs, h.adapter.game, "capture_city", sim.idx(0, 1),
            self._constraints(backend, avoid={(0, 0)}), "normal")
        self.assertIsNone(avoided["next_move"], avoided)
        self.assertEqual(avoided["reason"], "avoid")

    def test_native_path_has_no_hidden_cross_step(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=20)
        sim.tile(0, 1, owner=0, army=4)
        sim.tile(0, 2, owner=1, army=3, city=True)
        sim.tile(0, 8, owner=0, army=2, general=0)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), self._constraints(backend), "normal")
        self.assertTrue(candidate["path"], candidate)
        for left, right in zip(candidate["path"], candidate["path"][1:]):
            lx, ly = sim.xy(left)
            rx, ry = sim.xy(right)
            self.assertEqual(abs(lx - rx) + abs(ly - ry), 1, candidate["path"])


if __name__ == "__main__":
    unittest.main()
