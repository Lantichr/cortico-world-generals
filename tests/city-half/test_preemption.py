import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim, goal, intent, state  # noqa: E402


def threat_board():
    sim = Sim(15, 15, players=2)
    sim.tile(7, 7, owner=0, army=3, general=0)
    sim.tile(0, 7, owner=0, army=20)
    sim.tile(0, 0, owner=0, army=5, city=True)
    sim.tile(14, 14, owner=1, army=10, general=1)
    sim.tile(8, 8, owner=1, army=20)     # adjacent to our general: visible, generalKnownToEnemy
    return sim


class PreemptionTest(unittest.TestCase):
    def test_emergency_defense_preempts_and_recovers(self):
        sim = threat_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (0, 0)), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertIn("emergency_general_defense", out["strategyFeedback"]["reason"])
        self.assertEqual(out["task"]["kind"], "gather")
        self.assertEqual(out["task"]["target"], sim.idx(0, 0))
        evidence = out["diagnostics"]["preemption"]["evidence"]
        self.assertGreater(evidence["threat"], 0)
        self.assertLessEqual(evidence["garrison"], evidence["needed"])
        # The defense step must move toward the general, not away from it.
        self.assertLessEqual(sim.xy(out["move"]["to"])[1], sim.xy(out["move"]["from"])[1] + 0)
        if out["move"]:
            sim.apply_move(0, out["move"])
        else:
            sim.advance()
        # Threat removed: no more preemption, the task resumes.
        sim.owner[sim.idx(8, 8)] = -1
        sim.army[sim.idx(8, 8)] = 0
        sim.advance()
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertEqual(out["task"]["kind"], "gather")
        self.assertEqual(out["task"]["target"], sim.idx(0, 0))

    def test_no_false_emergency_without_threat(self):
        sim = Sim(15, 15, players=2)
        sim.tile(7, 7, owner=0, army=10, general=0)
        sim.tile(0, 7, owner=0, army=10)
        sim.tile(14, 14, owner=1, army=10, general=1)
        sim.tile(4, 4, owner=1, army=3, city=True)
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 4)), revision=1)
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertNotIn("preemption", out["diagnostics"])

    def test_preemption_obeys_reserve(self):
        sim = threat_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (0, 0)), revision=1,
                        constraints={"reserves": [{"tile": {"x": 0, "y": 7}, "armies": 19}]})
        out = h.step(state(active))
        # The only useful defense source cannot leave 19 behind, so preemption is denied.
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertIn("preemptionDenied", out["diagnostics"])

    def test_mountain_wall_blocks_manhattan_threat(self):
        sim = Sim(15, 15, players=2)
        sim.tile(7, 7, owner=0, army=3, general=0)
        sim.tile(0, 7, owner=0, army=20)
        sim.tile(0, 0, owner=0, army=5, city=True)
        sim.tile(14, 14, owner=1, army=10, general=1)
        sim.tile(7, 10, owner=0, army=5)                  # outpost sees the threat
        sim.tile(7, 9, owner=1, army=20)                  # Manhattan distance 2, wall between
        for x in range(15):
            sim.mountain(x, 8)
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (0, 0)), revision=1)
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertNotIn("preemption", out["diagnostics"])

    def test_preemption_from_main_is_tracked_by_observation(self):
        sim = threat_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (0, 0)), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "preempted")
        main = out["task"]["mainTile"]
        self.assertEqual(main, sim.idx(0, 7))
        self.assertEqual(out["move"]["from"], main)
        sim.apply_move(0, out["move"])
        sim.owner[sim.idx(8, 8)] = -1
        sim.army[sim.idx(8, 8)] = 0
        sim.advance()
        # Observe the confirmed migration before the native executor selects its next source.
        adapter = h.adapter
        from harris_env import server_data
        from backend import Observation
        observation = sim.observation(0)
        adapter.game.update(server_data(observation))
        adapter.backend.obs = Observation(observation, 0)
        adapter.backend._verify_pending(sim.turn + 1)
        self.assertEqual(adapter.backend.task["main"], sim.idx(1, 7))
        out = h.step(state(active))
        self.assertEqual(out["task"]["target"], sim.idx(0, 0))
        self.assertEqual(out["strategyFeedback"]["status"], "following")

    def test_one_step_general_capture_is_declared_preemption(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=5, general=0)
        sim.tile(4, 4, owner=0, army=10)
        sim.tile(3, 0, owner=0, army=3, city=True)
        sim.tile(5, 4, owner=1, army=2, general=1)
        sim.tile(8, 8, owner=1, army=5, city=True)
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (3, 0)), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertIn("one_step_general_capture", out["strategyFeedback"]["reason"])
        self.assertEqual(out["move"], {"from": sim.idx(4, 4), "to": sim.idx(5, 4), "half": False})
        self.assertEqual(out["task"]["kind"], "gather")
        self.assertEqual(out["task"]["target"], sim.idx(3, 0))
        sim.apply_move(0, out["move"])
        self.assertTrue(sim.dead[1])

    def test_one_step_capture_respects_avoid(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=5, general=0)
        sim.tile(4, 4, owner=0, army=10)
        sim.tile(3, 0, owner=0, army=3, city=True)
        sim.tile(5, 4, owner=1, army=2, general=1)
        sim.tile(8, 8, owner=1, army=5, city=True)
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (3, 0)), revision=1,
                        constraints={"avoidTiles": [{"x": 5, "y": 4}]})
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        if out["move"]:
            self.assertNotEqual(out["move"]["to"], sim.idx(5, 4))
            self.assertNotEqual(out["move"]["from"], sim.idx(5, 4))


class ConstraintTest(unittest.TestCase):
    def _capture_sim(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=3, general=0)
        sim.tile(4, 4, owner=0, army=5)
        sim.tile(4, 7, owner=1, army=1, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        return sim

    def test_reserve_full_and_half_boundary(self):
        sim = self._capture_sim()
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1)))
        self.assertEqual(out["move"], {"from": sim.idx(4, 4), "to": sim.idx(4, 5), "half": False})
        sim.advance()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 4, "y": 4}, "armies": 3}]})))
        self.assertEqual(out["move"], {"from": sim.idx(4, 4), "to": sim.idx(4, 5), "half": True})
        self.assertGreaterEqual(sim.army[sim.idx(4, 4)] - sim.army[sim.idx(4, 4)] // 2, 3)
        sim.advance()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1,
                                  constraints={"reserves": [{"tile": {"x": 4, "y": 4}, "armies": 5}]})))
        self.assertNotEqual(out["move"] and out["move"]["from"], sim.idx(4, 4))

    def test_avoid_detours_and_blocks(self):
        sim = self._capture_sim()
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1,
                                  constraints={"avoidTiles": [{"x": 4, "y": 5}]})))
        self.assertIsNotNone(out["move"], out)
        self.assertNotEqual(out["move"]["to"], sim.idx(4, 5))
        self.assertNotEqual(out["move"]["from"], sim.idx(4, 5))
        sim.advance()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1,
                                  constraints={"avoidTiles": [{"x": 4, "y": 7}]})))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        if out["move"]:
            self.assertNotIn(out["move"]["to"], (sim.idx(4, 7),))
            self.assertNotIn(out["move"]["from"], (sim.idx(4, 7),))


    def test_avoid_source_blocks_that_source(self):
        sim = self._capture_sim()
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1,
                                  constraints={"avoidTiles": [{"x": 4, "y": 4}]})))
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], sim.idx(4, 4))
            self.assertNotEqual(out["move"]["to"], sim.idx(4, 4))
        self.assertEqual(out["task"]["target"], sim.idx(4, 7))

    def test_blocked_task_does_not_spend_main(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=1, general=0)
        sim.tile(4, 4, owner=0, army=40)
        sim.tile(4, 7, owner=1, army=1, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        # Reserve more than the stack can leave behind, and avoid the only other source.
        active = intent(goal("capture_city", (4, 7)), revision=1,
                        constraints={"reserves": [{"tile": {"x": 4, "y": 4}, "armies": 40}],
                                     "avoidTiles": [{"x": 0, "y": 0}]})
        out = h.step(state(active))
        self.assertEqual(out["task"]["mainTile"], sim.idx(4, 4))
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], sim.idx(4, 4))
        # The blocked report must stay blocked, not silently clear the task.
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertEqual(out["task"]["kind"], "capture_city")


if __name__ == "__main__":
    unittest.main()
