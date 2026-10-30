import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim, goal, intent, state  # noqa: E402


class RawObservationTest(unittest.TestCase):
    def test_scout_does_not_complete_on_fogged_stale_map(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(0, 3, owner=0, army=5)                  # outpost sees the enemy general
        sim.tile(0, 4, owner=1, army=5, general=1)
        h = Harness(sim)
        h.prime()                                        # target is currently visible
        # Lose the outpost: the enemy general becomes fog for us while Harris Map keeps the sighting.
        sim.tile(0, 3, owner=1, army=12)
        sim.advance()
        active = intent(goal("scout", (0, 4)), revision=1)
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "completed")
        self.assertEqual(out["task"]["kind"], "scout")
        # The raw frame says the target is fog; a stale Map sighting must not be current fact.
        self.assertFalse(sim.visible(0)[sim.idx(0, 4)])

    def test_emergency_uses_current_visibility_not_stale_threat(self):
        sim = Sim(15, 15, players=2)
        sim.tile(7, 7, owner=0, army=3, general=0)
        sim.tile(0, 7, owner=0, army=20)
        sim.tile(0, 0, owner=0, army=5, city=True)
        sim.tile(14, 14, owner=1, army=10, general=1)
        sim.tile(8, 8, owner=1, army=20)                  # adjacent: sets generalKnownToEnemy
        h = Harness(sim)
        h.prime()
        # Remove the adjacent enemy, then expose a different stack through an outpost.
        sim.tile(8, 8, owner=-1, army=0)
        sim.tile(7, 10, owner=0, army=5)                  # outpost
        sim.tile(7, 11, owner=1, army=20)                 # visible only through the outpost
        sim.advance()
        # The outpost dies; the 20 stack becomes fog, but Harris Map still holds it.
        sim.tile(7, 10, owner=1, army=30)
        sim.advance()
        active = intent(goal("gather", (0, 0)), revision=1)
        out = h.step(state(active))
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertFalse(sim.visible(0)[sim.idx(7, 11)])

    def test_dead_uses_score_ids_not_array_position(self):
        sim = Sim(9, 9, players=3)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(8, 0, owner=1, army=10, general=1)
        sim.tile(8, 8, owner=2, army=10, general=2)
        sim.tile(0, 8, owner=0, army=20)
        h = Harness(sim)
        h.prime()
        # Referee scores are rank-ordered; a misplaced array position must not hide death.
        sim.dead[1] = True
        obs = sim.observation(0)
        obs["scores"] = list(reversed(obs["scores"]))
        out = h.adapter.step({"observation": obs,
                              "context": {"gameId": "t", "controlEpoch": 1, "revision": 99},
                              "strategy": state(intent(goal("attack_general", player=1), revision=1))})
        self.assertEqual(out["strategyFeedback"]["status"], "completed")


class EpochRevisionTest(unittest.TestCase):
    def _board(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(4, 6, owner=0, army=20)
        sim.tile(4, 7, owner=1, army=2, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        return sim

    def test_epoch_reset_accepts_lower_revision(self):
        sim = self._board()
        h = Harness(sim)
        h.prime()
        first = h.step(state(intent(goal("capture_city", (4, 7)), revision=5, epoch=1)))
        self.assertEqual(first["strategyFeedback"]["revision"], 5)
        second = h.step(state(intent(goal("capture_city", (4, 7)), revision=1, epoch=2)),
                        context={"gameId": "t", "controlEpoch": 2, "revision": 1})
        self.assertIsNotNone(second["strategyFeedback"], second)
        self.assertEqual(second["strategyFeedback"]["revision"], 1)
        self.assertNotEqual(second["strategyFeedback"]["status"], "blocked")

    def test_clear_prevents_old_active_revival(self):
        sim = self._board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=5)
        h.step(state(active))
        h.step({"active": None, "status": "cancelled", "reason": "cleared_by_s2",
                "lastRevision": 6, "lastRejection": None})
        # A stale snapshot of the old active intent must not revive the task.
        out = h.step(state(active))
        self.assertIsNone(out["strategyFeedback"])
        self.assertEqual(out["task"]["kind"], "auto")

    def test_context_revision_regression_is_stale(self):
        sim = self._board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1)
        h.step(state(active), context={"gameId": "t", "controlEpoch": 1, "revision": 5})
        sim.advance()
        out = h.step(state(active), context={"gameId": "t", "controlEpoch": 1, "revision": 4})
        self.assertTrue(out["diagnostics"]["staleContext"])
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertEqual(out["strategyFeedback"]["reason"], "stale_context")
        self.assertIsNone(out["move"])
        # The valid task is kept, not replaced by an unconstrained auto move.
        self.assertEqual(out["task"]["kind"], "capture_city")
        self.assertEqual(out["task"]["target"], sim.idx(4, 7))

    def test_turn_regression_with_higher_revision_is_stale(self):
        sim = self._board()
        h = Harness(sim)
        h.prime()
        active = intent(goal("capture_city", (4, 7)), revision=1)
        h.step(state(active), context={"gameId": "t", "controlEpoch": 1, "revision": 5})
        sim.advance()
        sim.turn -= 2                                    # a request for an older turn
        out = h.step(state(active), context={"gameId": "t", "controlEpoch": 1, "revision": 9})
        self.assertTrue(out["diagnostics"]["staleContext"])
        self.assertIsNone(out["move"])
        self.assertEqual(out["task"]["kind"], "capture_city")

    def test_epoch_reset_releases_historical_general_sightings(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(0, 3, owner=0, army=5)                  # outpost sees the enemy general
        sim.tile(0, 4, owner=1, army=5, general=1)
        h = Harness(sim)
        h.prime()
        sim.tile(0, 3, owner=1, army=12)                 # outpost lost; enemy general now fog
        sim.advance()
        out = h.step(state(intent(goal("attack_general", player=1), revision=1, epoch=2)),
                     context={"gameId": "t", "controlEpoch": 2, "revision": 1})
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        self.assertIn("target_general_location_unknown", out["strategyFeedback"]["reason"])

    def test_init_control_epoch_is_reported_and_used(self):
        sim = self._board()
        h = Harness(sim, control_epoch=3)
        self.assertEqual(h.init["controlEpoch"], 3)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (4, 7)), revision=1, epoch=3)))
        self.assertIsNotNone(out["strategyFeedback"], out)
        self.assertEqual(out["task"]["kind"], "capture_city")
        self.assertEqual(out["diagnostics"]["epoch"], 3)

    def test_old_epoch_is_rejected_without_resetting_task(self):
        sim = self._board()
        h = Harness(sim, control_epoch=3)
        h.prime()
        active = state(intent(goal("capture_city", (4, 7)), revision=1, epoch=3))
        first = h.step(active)
        self.assertEqual(first["task"]["kind"], "capture_city")
        old = h.adapter.step({"observation": h.observe(),
                              "context": {"gameId": "t", "controlEpoch": 2, "revision": 10},
                              "strategy": active})
        self.assertTrue(old["diagnostics"]["oldEpoch"])
        self.assertIsNone(old["move"])
        self.assertEqual(old["strategyFeedback"]["status"], "blocked")
        self.assertEqual(old["strategyFeedback"]["reason"], "old_epoch")
        self.assertEqual(old["task"]["kind"], "capture_city")
        self.assertEqual(old["task"]["target"], sim.idx(4, 7))
        # The current epoch/task still works after the old request.
        sim.advance()
        out = h.step(active)
        self.assertEqual(out["task"]["kind"], "capture_city")
        self.assertEqual(out["diagnostics"]["epoch"], 3)

    def test_same_frame_replay_does_not_confirm(self):
        sim = self._board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("capture_city", (4, 7)), revision=1))
        first = h.step(active, context={"gameId": "t", "controlEpoch": 1, "revision": 7})
        main = first["task"]["mainTile"]
        replay = h.step(active, context={"gameId": "t", "controlEpoch": 1, "revision": 7})
        self.assertTrue(replay["diagnostics"]["sameFrame"])
        self.assertEqual(replay["task"]["mainTile"], main)
        self.assertEqual(replay["move"], first["move"])


class ExpandGatherTest(unittest.TestCase):
    def test_expand_can_use_and_transfer_main(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=5, general=0)
        sim.tile(4, 4, owner=0, army=10)                 # largest: the expand main
        sim.tile(5, 4, owner=-1, army=0)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("expand"), revision=1))
        first = h.step(active)
        self.assertEqual(first["move"]["from"], sim.idx(4, 4))
        self.assertEqual(first["task"]["mainTile"], sim.idx(4, 4))
        sim.apply_move(0, first["move"])
        second = h.step(active)
        self.assertEqual(second["task"]["mainTile"], first["move"]["to"])

    def test_gather_keeps_main_across_unconfirmed_frame(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)       # target
        sim.tile(4, 0, owner=0, army=40)                 # best long route
        sim.tile(0, 3, owner=0, army=10)                 # nearer alternative
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("gather", (0, 4)), revision=1))
        first = h.step(active)
        source = first["move"]["from"]
        self.assertEqual(first["task"]["mainTile"], source)
        sim.advance()                                    # move not executed
        second = h.step(active)
        self.assertEqual(second["task"]["mainTile"], source)
        self.assertEqual(second["move"]["from"], source)

    def test_gather_holds_target_and_continues(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)
        sim.tile(0, 3, owner=0, army=10)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("gather", (0, 4)), revision=1))
        target = sim.idx(0, 4)
        for _ in range(3):
            out = h.step(active)
            if out["move"]:
                self.assertNotEqual(out["move"]["from"], target)
                sim.apply_move(0, out["move"])
            else:
                sim.advance()
        self.assertEqual(sim.owner[target], 0)
        out = h.step(active)
        self.assertNotEqual(out["task"]["mainTile"], target)
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], target)

    def test_known_lethal_first_step_detours_or_blocks(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=6, general=0)
        sim.tile(1, 2, owner=0, army=2)                  # makes the 50 stack visible
        sim.tile(0, 2, owner=1, army=50)
        sim.tile(0, 4, owner=1, army=1, city=True)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (0, 4)), revision=1)))
        if out["move"]:
            self.assertNotEqual(out["move"]["to"], sim.idx(0, 2))
            self.assertNotEqual(out["move"]["from"], sim.idx(0, 2))
            self.assertEqual(out["move"]["from"], sim.idx(0, 0))

    def test_fully_blocked_lethal_path_is_reported(self):
        sim = Sim(7, 7, players=2)
        sim.tile(0, 0, owner=0, army=6, general=0)
        sim.tile(0, 1, owner=1, army=50)
        sim.tile(1, 0, owner=1, army=50)
        sim.tile(0, 4, owner=1, army=1, city=True)
        sim.tile(6, 6, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step(state(intent(goal("capture_city", (0, 4)), revision=1)))
        self.assertEqual(out["strategyFeedback"]["status"], "blocked")
        if out["move"]:
            self.assertNotIn(out["move"]["to"], (sim.idx(0, 1), sim.idx(1, 0)))


    def test_transport_confirmation_uses_official_production_phase(self):
        def board():
            sim = Sim(9, 9, players=2)
            sim.tile(0, 0, owner=0, army=2, general=0)
            sim.tile(0, 4, owner=0, army=5, city=True)
            sim.tile(0, 3, owner=0, army=20)
            sim.tile(8, 8, owner=1, army=10, general=1)
            return sim

        self.assertEqual(BackendProduction.ticks(2, 3), 0)
        self.assertEqual(BackendProduction.ticks(3, 4), 1)
        # Turn 2 -> 3 is a non-production frame: the destination city stays at 5 + 19.
        sim = board()
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("gather", (0, 4)), revision=1))
        first = h.step(active)
        sim.apply_move(0, first["move"])
        self.assertEqual(sim.turn, 3)
        self.assertEqual(sim.army[sim.idx(0, 4)], 25)
        out = h.step(active)
        self.assertIsNone(out["diagnostics"]["lastRejectedStep"])
        self.assertEqual(sim.army[sim.idx(0, 4)], 25)
        # Turn 3 -> 4 produces: the same transport arrives at 26 and still confirms.
        sim = board()
        h = Harness(sim)
        h.prime()
        sim.advance()                                    # turn 3, no production
        first = h.step(active)
        sim.apply_move(0, first["move"])
        self.assertEqual(sim.turn, 4)
        self.assertEqual(sim.army[sim.idx(0, 4)], 26)
        out = h.step(active)
        self.assertIsNone(out["diagnostics"]["lastRejectedStep"])


class BackendProduction:
    @staticmethod
    def ticks(start, end):
        from backend import Backend
        return Backend._production_ticks(start, end)

    @staticmethod
    def land(start, end):
        from backend import Backend
        return Backend._land_ticks(start, end)


class PendingConfirmationTest(unittest.TestCase):
    def _growth_board(self, source_city=False):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)
        sim.tile(0, 3, owner=0, army=30, city=source_city)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        return sim, h

    def test_source_land_growth_at_50_and_100(self):
        self.assertEqual(BackendProduction.land(49, 50), 1)
        self.assertEqual(BackendProduction.land(99, 100), 1)
        self.assertEqual(BackendProduction.land(50, 51), 0)
        for target_turn in (49, 99):
            sim, h = self._growth_board()
            while sim.turn < target_turn:
                sim.advance()
            sim.army[sim.idx(0, 0)] = 2
            sim.army[sim.idx(0, 3)] = 30
            active = state(intent(goal("gather", (0, 4)), revision=1))
            out = h.step(active)
            self.assertEqual(out["move"]["from"], sim.idx(0, 3), (target_turn, out))
            sim.apply_move(0, out["move"])
            self.assertEqual(sim.turn, target_turn + 1)
            self.assertEqual(sim.army[sim.idx(0, 3)], 2)
            nxt = h.step(active)
            self.assertIsNone(nxt["diagnostics"]["lastRejectedStep"], (target_turn, nxt))

    def test_source_city_and_land_growth_stack(self):
        sim, h = self._growth_board(source_city=True)
        while sim.turn < 49:
            sim.advance()
        sim.army[sim.idx(0, 0)] = 2
        sim.army[sim.idx(0, 3)] = 30
        active = state(intent(goal("gather", (0, 4)), revision=1))
        out = h.step(active)
        self.assertEqual(out["move"]["from"], sim.idx(0, 3), out)
        sim.apply_move(0, out["move"])
        self.assertEqual(sim.turn, 50)
        self.assertEqual(sim.army[sim.idx(0, 3)], 3)     # 1 + city tick + land tick
        nxt = h.step(active)
        self.assertIsNone(nxt["diagnostics"]["lastRejectedStep"], nxt)

    def test_own_destination_needs_army_delta(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)
        sim.tile(0, 3, owner=0, army=20)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("gather", (0, 4)), revision=1))
        first = h.step(active)
        self.assertEqual(first["move"], {"from": sim.idx(0, 3), "to": sim.idx(0, 4), "half": False})
        sim.advance()                                    # move not executed; production only
        second = h.step(active)
        self.assertEqual(second["task"]["mainTile"], sim.idx(0, 3))
        self.assertEqual(second["diagnostics"]["lastRejectedStep"]["reason"], "own_destination_army_missing")

    def test_replay_then_apply_confirms_once(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=2, general=0)
        sim.tile(0, 4, owner=0, army=5, city=True)
        sim.tile(0, 3, owner=0, army=20)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        active = state(intent(goal("gather", (0, 4)), revision=1))
        first = h.step(active)
        replay = h.step(active)                          # same turn/revision
        self.assertTrue(replay["diagnostics"]["sameFrame"])
        self.assertEqual(replay["task"]["mainTile"], first["task"]["mainTile"])
        sim.apply_move(0, first["move"])
        out = h.step(active)
        self.assertEqual(sim.owner[sim.idx(0, 4)], 0)
        self.assertGreaterEqual(sim.army[sim.idx(0, 4)], 25)
        self.assertNotEqual(out["task"]["mainTile"], sim.idx(0, 3))
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], sim.idx(0, 4))


class OneStepCaptureHalfTest(unittest.TestCase):
    def _board(self, army, reserve):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=5, general=0)
        sim.tile(4, 4, owner=0, army=army)
        sim.tile(4, 3, owner=1, army=2, general=1)
        sim.tile(3, 0, owner=0, army=3, city=True)
        sim.tile(8, 8, owner=1, army=5, city=True)
        h = Harness(sim)
        h.prime()
        active = intent(goal("gather", (3, 0)), revision=1,
                        constraints={"reserves": [{"tile": {"x": 4, "y": 4}, "armies": reserve}]})
        return sim, h.step(state(active))

    def test_half_must_still_beat_the_general(self):
        sim, out = self._board(7, 5)
        self.assertNotEqual(out["strategyFeedback"]["status"], "preempted")
        if out["move"]:
            self.assertNotEqual(out["move"]["to"], sim.idx(4, 3))

    def test_half_capture_only_when_sent_wins(self):
        sim, out = self._board(10, 5)
        self.assertEqual(out["strategyFeedback"]["status"], "preempted")
        self.assertIn("one_step_general_capture", out["strategyFeedback"]["reason"])
        self.assertTrue(out["move"]["half"])
        sent = sim.army[sim.idx(4, 4)] // 2
        self.assertGreater(sent, sim.army[sim.idx(4, 3)])


class ConstraintSchemaTest(unittest.TestCase):
    def test_shared_final_gate(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(4, 4, owner=0, army=6)
        sim.tile(0, 4, owner=1, army=2, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        backend = h.adapter.backend
        h.step()  # updates backend.obs from the current frame
        obs, game = backend.obs, h.adapter.game
        constraints = backend._parse_constraints({"constraints": {}})
        self.assertEqual(constraints.check(obs, game, {"from": 0, "to": 0, "half": False}), "strategy_adjacency")
        self.assertEqual(constraints.check(obs, game, {"from": 0, "to": 999, "half": False}), "strategy_bounds")
        self.assertEqual(constraints.check(obs, game, {"from": 0, "to": 1, "half": 1}), "strategy_schema")
        self.assertEqual(constraints.check(obs, game, {"from": 1, "to": 2, "half": False}),
                         "strategy_source_not_currently_owned")
        self.assertEqual(constraints.check(obs, game, {"from": 4 * 9 + 4, "to": 4 * 9 + 5, "half": False}), None)
        self.assertEqual(constraints.check(obs, game, {"from": 4 * 9 + 4, "to": 0 * 9 + 3, "half": False}),
                         "strategy_adjacency")

    def test_weakening_attack_is_legal_but_not_a_capture_candidate(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(4, 4, owner=0, army=5)
        sim.tile(4, 5, owner=1, army=8)                  # visible; 4 sent cannot take it
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()                                         # advance backend.obs to the current frame
        backend = h.adapter.backend
        constraints = backend._parse_constraints({"constraints": {}})
        move = {"from": sim.idx(4, 4), "to": sim.idx(4, 5), "half": False}
        self.assertIsNone(constraints.check(backend.obs, h.adapter.game, move, require_capture=False))
        self.assertEqual(constraints.check(backend.obs, h.adapter.game, move, require_capture=True),
                         "strategy_insufficient_capture")

    def test_auto_rejected_blob_move_is_diagnosed(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(1, 0, owner=0, army=3)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        # The pinned blob moves off the general; an avoid constraint blocks that source, so the
        # rejected proposal must be reported rather than silently replaced.
        out = h.step(state(intent(goal("auto"), revision=1,
                                  constraints={"avoidTiles": [{"x": 0, "y": 0}]})))
        self.assertIn("autoRejected", out["diagnostics"], out)
        if out["move"]:
            self.assertNotEqual(out["move"]["from"], sim.idx(0, 0))


if __name__ == "__main__":
    unittest.main()
