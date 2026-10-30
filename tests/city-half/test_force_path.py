import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import backend as backend_module  # noqa: E402
from sim import Harness, Sim, goal, intent, state  # noqa: E402


class ForcePathTest(unittest.TestCase):
    def _backend(self, sim):
        h = Harness(sim)
        h.prime()
        return h, h.adapter.backend

    def _constraints(self, backend, reserves=None, avoid=None):
        raw = {}
        if reserves:
            raw["reserves"] = [{"tile": {"x": x, "y": y}, "armies": armies}
                               for (x, y), armies in reserves.items()]
        if avoid:
            raw["avoidTiles"] = [{"x": x, "y": y} for x, y in avoid]
        return backend._parse_constraints({"constraints": raw})

    def test_pickup_on_route_can_capture_static_target(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 1, owner=0, army=10)
        sim.tile(0, 2, owner=1, army=24, city=True)     # becomes 25 at turn 2
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2), constraints, "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["path"], [sim.idx(0, 0), sim.idx(0, 1), sim.idx(0, 2)])
        self.assertGreater(plan["delivered"], 0)
        self.assertLess(plan["delivered"], 29)           # not the 20 + 10 sum minus one per tile

        active = state(intent(goal("capture_city", (0, 2)), revision=1))
        first = h.step(active)
        self.assertEqual(first["move"]["from"], sim.idx(0, 0))
        sim.apply_move(0, first["move"])
        second = h.step(active)
        self.assertEqual(second["move"]["from"], sim.idx(0, 1))
        sim.apply_move(0, second["move"])
        third = h.step(active)
        self.assertEqual(third["strategyFeedback"]["status"], "completed")

    def test_static_chain_runs_out_of_force(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 1, owner=1, army=12)
        sim.tile(0, 2, owner=1, army=11, city=True)     # becomes 12 at turn 2
        sim.tile(1, 2, owner=0, army=2)                  # makes the second enemy visible
        sim.mountain(1, 0)
        sim.mountain(1, 1)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2), constraints, "normal")
        self.assertFalse(plan["feasible"], plan)
        self.assertEqual(plan["reason"], "insufficient_force")

        out = h.step(state(intent(goal("capture_city", (0, 2)), revision=1)))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertEqual(out["diagnostics"]["taskResult"]["blocked"], "insufficient_visible_force")
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], sim.idx(0, 0))
            self.assertNotEqual(out["move"]["to"], sim.idx(0, 2))

    def test_reserve_forces_half_and_strict_capture(self):
        def board(target_army):
            sim = Sim(5, 5, players=2)
            sim.tile(0, 0, owner=0, army=50, general=0)
            sim.tile(0, 1, owner=1, army=target_army, city=True)
            sim.mountain(1, 0)
            sim.mountain(1, 1)
            sim.tile(4, 4, owner=1, army=10, general=1)
            return sim

        sim = board(22)                                 # becomes 23 at turn 2; 25 half wins
        h, backend = self._backend(sim)
        constraints = self._constraints(backend, reserves={(0, 0): 10})
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 1), constraints, "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["splits"], [True])
        self.assertEqual(plan["delivered"], 3)
        out = h.step(state(intent(goal("capture_city", (0, 1)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 0, "y": 0}, "armies": 10}]})))
        self.assertEqual(out["move"], {"from": sim.idx(0, 0), "to": sim.idx(0, 1), "half": True})
        remaining = sim.army[sim.idx(0, 0)] - sim.army[sim.idx(0, 0)] // 2
        self.assertGreaterEqual(remaining, 10)

        sim = board(30)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend, reserves={(0, 0): 10})
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 1), constraints, "normal")
        self.assertFalse(plan["feasible"], plan)
        out = h.step(state(intent(goal("capture_city", (0, 1)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 0, "y": 0}, "armies": 10}]})))
        self.assertIsNone(out["move"])
        self.assertEqual(out["diagnostics"]["taskResult"]["blocked"], "no_goal_source")

    def test_mountain_detour_and_avoid_block(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.mountain(0, 1)
        sim.tile(0, 2, owner=1, army=1, city=True)
        sim.tile(1, 2, owner=0, army=2)                  # target is visible via the outpost
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2), constraints, "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertNotEqual(plan["path"][1], sim.idx(0, 1))
        self.assertIn(sim.idx(1, 0), plan["path"])

        blocked = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2),
                                     self._constraints(backend, avoid={(1, 0)}), "normal")
        self.assertIsNone(blocked["path"])

    def test_reserve_on_intermediate_tile_forces_half(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 1, owner=0, army=20)
        sim.tile(0, 2, owner=1, army=18, city=True)     # becomes 19 at turn 2
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend, reserves={(0, 1): 20})
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2), constraints, "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["path"], [sim.idx(0, 0), sim.idx(0, 1), sim.idx(0, 2)])
        self.assertEqual(plan["splits"], [False, True])
        out = h.step(state(intent(goal("capture_city", (0, 2)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 0, "y": 1}, "armies": 20}]})))
        self.assertFalse(out["move"]["half"])
        sim.apply_move(0, out["move"])
        out = h.step(state(intent(goal("capture_city", (0, 2)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 0, "y": 1}, "armies": 20}]})))
        self.assertTrue(out["move"]["half"], out)
        self.assertEqual(out["move"]["from"], sim.idx(0, 1))

    def test_gather_source_uses_deliverable_force_with_reserve(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)       # gather target
        sim.tile(0, 3, owner=0, army=50)                 # large but reserve makes it immobile
        sim.tile(1, 4, owner=0, army=20)                 # actually deliverable
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        backend = h.adapter.backend
        constraints = self._constraints(backend, reserves={(0, 3): 40})
        chosen = backend._best_gather_source(h.adapter.game, sim.idx(0, 4), constraints, None)
        self.assertEqual(chosen, sim.idx(1, 4))

    def test_native_gather_preserves_bounded_search_budget(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)
        sim.tile(0, 3, owner=0, army=20)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("gather", (0, 4)), revision=1)))
        planning = out["diagnostics"]["planning"]
        self.assertEqual(out["diagnostics"]["mode"], "task_native")
        self.assertEqual(out["move"], {"from": sim.idx(0, 3), "to": sim.idx(0, 4), "half": False})
        self.assertEqual(planning["nodesSpent"], 0)
        self.assertEqual(planning["calls"], 0)
        self.assertEqual(planning["frameBudget"], backend_module.MAX_FRAME_PLAN_NODES)
        self.assertEqual(planning["remaining"], planning["frameBudget"] - planning["nodesSpent"])

    def test_visible_short_gather_keeps_budget_for_execution(self):
        sim = Sim(9, 9, players=2)
        sim.tile(3, 4, owner=0, army=2, city=True)       # west city
        sim.tile(4, 4, owner=0, army=30, general=0)      # main
        for x in (5, 6, 7, 8):
            sim.tile(x, 4, owner=0, army=2)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("gather", (8, 4)), revision=1)))
        self.assertIn(out["task"]["mainTile"], (sim.idx(3, 4), sim.idx(4, 4)), out)
        self.assertEqual(out["move"]["to"], out["move"]["from"] + 1)
        self.assertGreater(out["diagnostics"]["planning"]["remaining"], 0)
        self.assertEqual(out["diagnostics"]["mode"], "task_native", out)
        self.assertTrue(out["diagnostics"]["taskResult"]["fullFeasible"], out)
        for _ in range(6):
            sim.apply_move(0, out["move"])
            out = h.step(state(intent(goal("gather", (8, 4)), revision=1)))
        self.assertGreaterEqual(sim.army[sim.idx(8, 4)], 30)

    def test_equal_length_alternative_keeps_more_force(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(1, 0, owner=0, army=2)
        sim.tile(0, 1, owner=0, army=20)
        sim.tile(1, 1, owner=1, army=5)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(1, 1),
                                  self._constraints(backend), "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["path"], [sim.idx(0, 0), sim.idx(0, 1), sim.idx(1, 1)])
        self.assertEqual(len(set(plan["path"])), len(plan["path"]))
        self.assertEqual(plan["delivered"], 33)

    def test_fog_route_is_conditional_not_current_force(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 2, owner=0, army=5)                  # outpost
        sim.tile(0, 3, owner=1, army=50)                 # seen, then fog
        sim.tile(0, 5, owner=1, army=7, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        sim.tile(0, 2, owner=1, army=30)                 # outpost lost: 0,3 and target fog
        sim.advance()
        backend = h.adapter.backend
        target = sim.idx(0, 5)
        self.assertFalse(backend.obs.is_visible(target))
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), target,
                                  self._constraints(backend), "normal")
        self.assertTrue(plan["conditional"], plan)
        self.assertFalse(plan["feasible"])
        self.assertIsNone(plan["army"])
        self.assertIsNone(plan["delivered"])
        self.assertTrue(plan["path"])

    def test_search_nodes_and_elapsed_are_bounded(self):
        sim = Sim(21, 21, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(20, 20, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        backend._plan_budget_remaining = 1000
        backend._plan_nodes_spent = 0
        backend._plan_calls = 0
        plan = backend._plan_path(h.adapter.game, 0, sim.idx(20, 20),
                                  self._constraints(backend), "normal")
        self.assertEqual(plan["nodes"], backend._plan_nodes_spent)
        self.assertLessEqual(plan["nodes"], backend_module.MAX_PLAN_NODES)
        self.assertLess(plan["planMs"], 1000.0, plan)

        old_states = backend_module.MAX_PLAN_STATES
        old_structural = backend_module.MAX_STRUCTURAL_NODES
        old_frame = backend_module.MAX_FRAME_PLAN_NODES
        backend_module.MAX_PLAN_STATES = 8
        backend_module.MAX_STRUCTURAL_NODES = 8
        backend_module.MAX_FRAME_PLAN_NODES = 16
        backend._plan_budget_remaining = 16
        backend._plan_nodes_spent = 0
        backend._plan_calls = 0
        try:
            capped = backend._plan_path(h.adapter.game, 0, sim.idx(20, 20),
                                         self._constraints(backend), "normal")
        finally:
            backend_module.MAX_PLAN_STATES = old_states
            backend_module.MAX_STRUCTURAL_NODES = old_structural
            backend_module.MAX_FRAME_PLAN_NODES = old_frame
        self.assertEqual(capped["nodes"], backend._plan_nodes_spent)
        self.assertLessEqual(capped["nodes"], 16)
        self.assertTrue(capped["boundHit"], capped)

    def test_shortest_feasible_route_beats_long_pickup(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 1, owner=0, army=2)                  # short: two steps
        sim.tile(0, 2, owner=1, army=5)                  # target
        sim.tile(1, 0, owner=0, army=20)                 # long: four steps, more army
        sim.tile(1, 1, owner=0, army=10)
        sim.tile(1, 2, owner=0, army=5)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), sim.idx(0, 2),
                                  self._constraints(backend), "normal")
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["path"], [sim.idx(0, 0), sim.idx(0, 1), sim.idx(0, 2)])
        self.assertEqual(plan["steps"], 2)

    def test_main_source_keeps_current_army_order(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=30, general=0)      # first by current army, lower arrival
        sim.tile(0, 1, owner=1, army=20)
        sim.tile(0, 2, owner=1, army=5, city=True)
        sim.tile(0, 3, owner=0, army=20)                 # second, higher arrival
        sim.tile(6, 6, owner=1, army=10, general=1)
        h, backend = self._backend(sim)
        constraints = self._constraints(backend)
        chosen = backend._choose_main(h.adapter.game, "capture_city", sim.idx(0, 2),
                                      constraints, None)
        self.assertEqual(chosen, sim.idx(0, 0))

    def test_unknown_boundary_is_adjacent_and_scout_executes(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=20, general=0)
        sim.tile(0, 2, owner=0, army=5)
        sim.tile(0, 3, owner=1, army=50)
        sim.tile(0, 5, owner=1, army=7, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        sim.tile(0, 2, owner=1, army=30)
        sim.advance()
        backend = h.adapter.backend
        target = sim.idx(0, 5)
        plan = backend._plan_path(h.adapter.game, sim.idx(0, 0), target,
                                  self._constraints(backend), "normal", allow_fog_target=True)
        self.assertTrue(plan["conditional"], plan)
        for left, right in zip(plan["path"], plan["path"][1:]):
            lx, ly = sim.xy(left)
            rx, ry = sim.xy(right)
            self.assertEqual(abs(lx - rx) + abs(ly - ry), 1, (left, right, plan["path"]))

        out = h.step(state(intent(goal("scout", (0, 5)), revision=1)))
        self.assertIsNotNone(out["move"], out)
        fx, fy = sim.xy(out["move"]["from"])
        tx, ty = sim.xy(out["move"]["to"])
        self.assertEqual(abs(fx - tx) + abs(fy - ty), 1, out["move"])
        sim.apply_move(0, out["move"])
        out = h.step(state(intent(goal("scout", (0, 5)), revision=1)))
        self.assertEqual(out["task"]["kind"], "scout")

    def test_frame_budget_is_shared_across_sources(self):
        sim = Sim(15, 15, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        for i in range(1, 8):
            sim.tile(i, 0, owner=0, army=20)
        sim.tile(14, 14, owner=1, army=10, general=1)
        sim.tile(7, 7, owner=0, army=5, city=True)       # gather target
        h, backend = self._backend(sim)
        old_frame = backend_module.MAX_FRAME_PLAN_NODES
        old_states = backend_module.MAX_PLAN_STATES
        old_structural = backend_module.MAX_STRUCTURAL_NODES
        backend_module.MAX_FRAME_PLAN_NODES = 12
        backend_module.MAX_PLAN_STATES = 8
        backend_module.MAX_STRUCTURAL_NODES = 8
        backend._plan_budget_remaining = 12
        backend._plan_nodes_spent = 0
        backend._plan_calls = 0
        try:
            backend._best_gather_source(h.adapter.game, sim.idx(7, 7),
                                        self._constraints(backend), None)
        finally:
            backend_module.MAX_FRAME_PLAN_NODES = old_frame
            backend_module.MAX_PLAN_STATES = old_states
            backend_module.MAX_STRUCTURAL_NODES = old_structural
        self.assertEqual(backend._plan_nodes_spent, 12)
        self.assertEqual(backend._plan_budget_remaining, 0)


if __name__ == "__main__":
    unittest.main()
