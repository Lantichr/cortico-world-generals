import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim, goal, intent, state  # noqa: E402


def base_sim():
    """9x9: our general (0,0), enemy general (8,8)."""
    sim = Sim(9, 9, players=2)
    sim.tile(0, 0, owner=0, army=10, general=0)
    sim.tile(8, 8, owner=1, army=10, general=1)
    return sim


class TaskBehaviorTest(unittest.TestCase):
    def test_gather_target_beats_nearest_holding(self):
        sim = Sim(9, 9, players=2)
        sim.tile(4, 4, owner=0, army=3, general=0)
        sim.tile(8, 8, owner=1, army=10, general=1)
        sim.tile(2, 0, owner=0, army=4, city=True)     # nearest holding for the field stack
        sim.tile(7, 0, owner=0, army=4, city=True)     # requested gather target
        sim.tile(4, 0, owner=0, army=30)               # field stack
        sim.tile(8, 0, owner=0, army=12)
        h = Harness(sim)
        h.prime()
        target = sim.idx(7, 0)
        active = intent(goal("gather", (7, 0)), revision=1)
        out = h.step(state(active))
        self.assertIsNotNone(out["move"], out)
        self.assertEqual(out["task"]["kind"], "gather")
        self.assertEqual(out["task"]["target"], target)
        self.assertEqual(out["strategyFeedback"]["status"], "following")
        # A nearest-holding gather would move the (4,0) stack left toward (2,0).
        from_x, from_y = sim.xy(out["move"]["from"])
        to_x, to_y = sim.xy(out["move"]["to"])
        self.assertEqual(from_y, 0)
        self.assertEqual(to_y, 0)
        self.assertGreater(to_x, from_x, out["move"])

    def test_capture_city_resists_cheap_expansion(self):
        sim = base_sim()
        sim.tile(4, 4, owner=0, army=40)
        sim.tile(3, 4, owner=-1, army=0)               # cheap off-path expansion
        sim.tile(4, 7, owner=1, army=10, city=True)    # designated city
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1)
        out = h.step(state(active))
        self.assertIsNotNone(out["move"], out)
        self.assertEqual(sim.xy(out["move"]["to"]), (4, 5))
        self.assertEqual(out["task"]["target"], sim.idx(4, 7))
        self.assertEqual(out["strategyFeedback"]["status"], "following")

    def test_main_force_transfers_only_after_observation(self):
        sim = base_sim()
        sim.tile(4, 4, owner=0, army=40)
        sim.tile(4, 8, owner=1, army=5, city=True)
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 8)), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["task"]["mainTile"], sim.idx(4, 4))
        self.assertEqual(sim.xy(out["move"]["to"]), (4, 5))
        # Apply our move; the destination is now owned, so the next observation confirms it.
        sim.apply_move(0, out["move"])
        out2 = h.step(state(active))
        self.assertEqual(out2["task"]["mainTile"], sim.idx(4, 5), out2)
        self.assertEqual(sim.xy(out2["move"]["from"]), (4, 5))

    def test_gather_never_withdraws_target_garrison(self):
        sim = base_sim()
        sim.tile(3, 0, owner=0, army=8, city=True)
        sim.tile(6, 0, owner=0, army=7)
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (3, 0)), revision=1)
        target = sim.idx(3, 0)
        for _ in range(4):
            out = h.step(state(active))
            if out["move"]:
                self.assertNotEqual(out["move"]["from"], target, out)
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
            self.assertEqual(sim.owner[target], 0)

    def test_scout_completes_when_target_enters_vision(self):
        sim = base_sim()
        target = sim.idx(0, 5)
        h = Harness(sim)
        h.prime()
        active = intent(goal("scout", (0, 5)), revision=1)
        completed = False
        for _ in range(6):
            out = h.step(state(active))
            if out["strategyFeedback"] and out["strategyFeedback"]["status"] == "completed":
                completed = True
                self.assertEqual(out["task"]["phase"], "completed")
                break
            if out["move"]:
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
        self.assertTrue(completed, "scout never observed completion")
        self.assertTrue(sim.visible(0)[target])

    def test_unknown_and_eliminated_general(self):
        sim = base_sim()
        h = Harness(sim)
        h.prime()
        active = intent(goal("attack_general", player=1), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertIn("target_general_location_unknown", out["strategyFeedback"]["reason"])
        self.assertEqual(out["task"]["phase"], "blocked")
        # Eliminated target is completed without inventing a coordinate.
        sim.dead[1] = True
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "completed")
        self.assertEqual(out["task"]["phase"], "completed")


    def test_attack_known_general_then_completed(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(4, 6, owner=0, army=30)
        sim.tile(4, 7, owner=1, army=5, general=1)
        h = Harness(sim)
        h.prime()
        active = intent(goal("attack_general", player=1), revision=1)
        out = h.step(state(active))
        self.assertEqual(out["task"]["kind"], "capture_general")
        self.assertIn(out["strategyFeedback"]["status"], ("following", "preempted"))
        self.assertEqual(sim.xy(out["move"]["to"]), (4, 7))
        sim.apply_move(0, out["move"])
        self.assertTrue(sim.dead[1])
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "completed")

    def test_defend_is_continuous_not_one_arrival(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(2, 2, owner=0, army=5, city=True)
        sim.tile(4, 2, owner=0, army=20)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = intent(goal("defend", (2, 2)), revision=1)
        target = sim.idx(2, 2)
        statuses = []
        for _ in range(4):
            out = h.step(state(active))
            statuses.append(out["strategyFeedback"]["status"])
            self.assertEqual(out["task"]["kind"], "defend")
            if out["move"]:
                self.assertNotEqual(out["move"]["from"], target)
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
        self.assertNotIn("completed", statuses)
        self.assertEqual(sim.owner[target], 0)

    def test_preference_emphasis_changes_expand_candidate(self):
        def board():
            sim = Sim(9, 9, players=2)
            sim.tile(0, 0, owner=0, army=5, general=0)
            sim.tile(4, 4, owner=0, army=10)
            sim.tile(5, 3, owner=0, army=6)
            sim.tile(5, 4, owner=-1, army=0, city=True)   # neutral city below (5,3)
            sim.tile(4, 3, owner=1, army=0, city=True)    # enemy city left of (5,3)
            sim.tile(8, 8, owner=1, army=10, general=1)
            return sim

        economy = board()
        h = Harness(economy)
        h.prime()
        out = h.step(state(intent(goal("expand"), revision=1,
                                  preferences={"emphasis": "economy", "risk": "normal"})))
        self.assertEqual(economy.xy(out["move"]["to"]), (5, 4))

        pressure = board()
        h = Harness(pressure)
        h.prime()
        out = h.step(state(intent(goal("expand"), revision=1,
                                  preferences={"emphasis": "pressure", "risk": "normal"})))
        self.assertEqual(pressure.xy(out["move"]["to"]), (4, 3))

    def test_low_risk_does_not_step_into_fog(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        normal = h.step(state(intent(goal("scout", (0, 6)), revision=1)))
        self.assertIsNotNone(normal["move"], normal)
        sim.advance()
        low = h.step(state(intent(goal("scout", (0, 6)), revision=1,
                                  preferences={"emphasis": "information", "risk": "low"})))
        if low["move"]:
            tile = h.adapter.game.grid[low["move"]["to"] // 9][low["move"]["to"] % 9]
            self.assertNotEqual(tile.tile, -3, low["move"])
        self.assertEqual(low["strategyFeedback"]["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
