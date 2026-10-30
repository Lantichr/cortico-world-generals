import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim, goal, intent, state  # noqa: E402


def capture_board():
    sim = Sim(9, 9, players=2)
    sim.tile(0, 0, owner=0, army=10, general=0)
    sim.tile(4, 6, owner=0, army=40)              # adjacent: one step captures the city
    sim.tile(4, 7, owner=1, army=2, city=True)
    sim.tile(8, 8, owner=1, army=10, general=1)
    return sim


class LifecycleTest(unittest.TestCase):
    def test_expiry_releases_task(self):
        sim = capture_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1, expires=sim.turn)
        out = h.step(state(active))
        self.assertIsNone(out["strategyFeedback"])
        self.assertEqual(out["task"]["kind"], "auto")

    def test_epoch_change_releases_task(self):
        sim = capture_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1, epoch=1)
        first = h.step(state(active))
        self.assertEqual(first["task"]["kind"], "capture_city")
        out = h.step(state(active), context={"gameId": "t", "controlEpoch": 2, "revision": 2})
        self.assertIsNone(out["strategyFeedback"])
        self.assertEqual(out["task"]["kind"], "auto")

    def test_new_revision_replaces_task(self):
        sim = capture_board()
        sim.tile(8, 0, owner=1, army=2, city=True)
        h = Harness(sim)
        h.prime()
        first = h.step(state(intent(goal("capture_city", (4, 7)), revision=1)))
        self.assertEqual(first["task"]["target"], sim.idx(4, 7))
        second = h.step(state(intent(goal("capture_city", (8, 0)), revision=2)))
        self.assertEqual(second["task"]["target"], sim.idx(8, 0))
        self.assertEqual(second["strategyFeedback"]["revision"], 2)

    def test_clear_releases_task(self):
        sim = capture_board()
        h = Harness(sim)
        h.prime()
        h.step(state(intent(goal("capture_city", (4, 7)), revision=1)))
        out = h.step({"active": None, "status": "cancelled", "reason": "cleared_by_s2",
                      "lastRevision": 1, "lastRejection": None})
        self.assertIsNone(out["strategyFeedback"])
        self.assertEqual(out["task"]["kind"], "auto")

    def test_completed_keeps_constraints(self):
        sim = capture_board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1)
        out = h.step(state(active))
        sim.apply_move(0, out["move"])
        out = h.step(state(active))
        self.assertEqual(out["strategyFeedback"]["status"], "completed")
        # Completed state still honours avoidTiles. Avoiding every owned tile leaves no legal
        # source, so the backend must wait rather than silently moving one of them.
        avoid = [{"x": sim.xy(index)[0], "y": sim.xy(index)[1]}
                 for index, owner in enumerate(sim.owner) if owner == 0]
        completed = intent(goal("capture_city", (4, 7)), revision=1, constraints={"avoidTiles": avoid})
        out = h.step({"active": completed, "status": "completed", "reason": "goal_observed_complete",
                      "lastRevision": 1, "lastRejection": None})
        self.assertEqual(out["strategyFeedback"]["status"], "completed")
        self.assertIsNone(out["move"])

    def test_enemy_first_does_not_continue_unconfirmed_step(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(4, 4, owner=0, army=40)
        sim.tile(4, 7, owner=1, army=2, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1)
        out = h.step(state(active))
        self.assertEqual(sim.xy(out["move"]["to"]), (4, 5))
        # The enemy acts first and holds the tile we intended to enter; our move never lands.
        sim.owner[sim.idx(4, 5)] = 1
        sim.army[sim.idx(4, 5)] = 3
        sim.advance()
        out = h.step(state(active))
        self.assertEqual(out["diagnostics"]["lastRejectedStep"]["reason"], "destination_not_owned")
        self.assertEqual(out["task"]["mainTile"], sim.idx(4, 4))
        self.assertNotEqual(out["move"] and out["move"]["from"], sim.idx(4, 5))

    def test_unsupported_values_are_blocked(self):
        sim = capture_board()
        h = Harness(sim)
        h.prime()
        bad_goal = intent({"kind": "teleport"}, revision=1)
        out = h.step(state(bad_goal))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertIn("unsupported_goal", out["strategyFeedback"]["reason"])
        bad_pref = intent(goal("capture_city", (4, 7)), revision=2,
                          preferences={"emphasis": "weird", "risk": "normal"})
        out = h.step(state(bad_pref))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertIn("unsupported", out["strategyFeedback"]["reason"])


class MultiPlayerTest(unittest.TestCase):
    def test_high_player_index_four_player_city_state(self):
        sim = Sim(11, 11, players=4)
        sim.tile(10, 0, owner=3, army=10, general=3)
        sim.tile(10, 2, owner=3, army=20)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(0, 10, owner=1, army=10, general=1)
        sim.tile(10, 10, owner=2, army=10, general=2)
        sim.tile(6, 6, owner=1, army=4, city=True)
        h = Harness(sim, player=3, mode="city-state", game_id="ffa")
        h.prime()
        active = intent(goal("capture_city", (6, 6)), revision=1, game="ffa")
        out = h.step(state(active))
        self.assertEqual(out["task"]["kind"], "capture_city")
        self.assertEqual(out["task"]["target"], sim.idx(6, 6))
        self.assertIsNotNone(out["move"], out)
        self.assertEqual(sim.owner[out["move"]["from"]], 3)

    def test_multi_step_gather_then_capture(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(4, 4, owner=0, army=24)
        sim.tile(4, 2, owner=0, army=4, city=True)   # staging point
        sim.tile(4, 7, owner=1, army=3, city=True)   # capture target
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        gather = state(intent(goal("gather", (4, 2)), revision=1))
        for _ in range(2):
            out = h.step(gather)
            self.assertEqual(out["task"]["kind"], "gather")
            if out["move"]:
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
        self.assertGreaterEqual(sim.army[sim.idx(4, 2)], 20)
        capture = state(intent(goal("capture_city", (4, 7)), revision=2))
        completed = False
        for _ in range(8):
            out = h.step(capture)
            if out["strategyFeedback"]["status"] == "completed":
                completed = True
                break
            if out["move"]:
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
        self.assertTrue(completed, "multi-step gather->capture did not complete")
        self.assertEqual(sim.owner[sim.idx(4, 7)], 0)
        self.assertTrue(sim.city[sim.idx(4, 7)])


    def test_player_seven_eight_player_board(self):
        sim = Sim(11, 11, players=8)
        sim.tile(10, 0, owner=7, army=10, general=7)
        sim.tile(10, 2, owner=7, army=20)
        for player, (x, y) in enumerate([(0, 0), (0, 10), (4, 0), (4, 10), (8, 0), (8, 10), (0, 5)]):
            sim.tile(x, y, owner=player, army=10, general=player)
        sim.tile(5, 5, owner=2, army=4, city=True)
        h = Harness(sim, player=7, mode="standard", game_id="p8")
        h.prime()
        plain = h.step()
        if plain["move"]:
            self.assertEqual(sim.owner[plain["move"]["from"]], 7)
        active = intent(goal("capture_city", (5, 5)), revision=1, game="p8")
        out = h.step(state(active))
        self.assertEqual(out["task"]["target"], sim.idx(5, 5))
        if out["move"]:
            self.assertEqual(sim.owner[out["move"]["from"]], 7)


if __name__ == "__main__":
    unittest.main()
