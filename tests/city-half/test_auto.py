import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from harris_env import HARRIS as ADAPTERS  # noqa: E402
if ADAPTERS not in sys.path:
    sys.path.insert(0, ADAPTERS)

from reference_adapter import Adapter as OriginalAdapter  # noqa: E402
from sim import Harness, Sim, goal, intent, state  # noqa: E402


def static_board(turn):
    width = height = 7
    terrain = [-1] * (width * height)
    armies = [0] * (width * height)
    terrain[0], armies[0] = 0, 12
    terrain[1], armies[1] = 0, 5
    terrain[8], armies[8] = 0, 4
    terrain[2], armies[2] = -1, 0
    terrain[48], armies[48] = 1, 12
    terrain[20], armies[20] = 1, 6
    return {"width": width, "height": height, "playerIndex": 0, "playerCount": 2, "turn": turn,
            "armies": armies, "terrain": terrain, "cities": [], "generals": [0, 48],
            "scores": [{"i": 0, "total": 21, "tiles": 3, "dead": False},
                       {"i": 1, "total": 18, "tiles": 2, "dead": False}], "teams": [0, 1]}


class AutoEquivalenceTest(unittest.TestCase):
    def _moves(self, adapter, strategy=None):
        moves = []
        for turn in range(1, 7):
            request = {"observation": static_board(turn)}
            if strategy is not None:
                request["strategy"] = strategy
            result = adapter.step(request)
            if result is None:
                moves.append(None)
            elif isinstance(result, dict) and "move" in result:
                moves.append(result["move"])
            else:
                moves.append(result)
        return moves

    def test_no_intent_same_seed_matches_original_blob(self):
        from adapter import Adapter as S2Adapter

        def normalize(result):
            if result is None:
                return None
            if isinstance(result, dict) and "move" in result:
                return result["move"]
            return result

        original = OriginalAdapter()
        original.init({"gameId": "eq", "playerIndex": 0, "playerCount": 2,
                       "width": 7, "height": 7, "mode": "standard", "seed": 11})
        ours = S2Adapter()
        ours.init({"gameId": "eq", "playerIndex": 0, "playerCount": 2,
                   "width": 7, "height": 7, "mode": "standard", "seed": 11})
        for turn in range(1, 7):
            reference = normalize(original.step({"observation": static_board(turn)}))
            mine = normalize(ours.step({"observation": static_board(turn)}))
            self.assertEqual(mine, reference, "turn %d" % turn)

    def test_active_auto_no_constraints_matches_no_intent(self):
        def build(seed):
            sim = Sim(7, 7, players=2, seed=seed)
            sim.tile(0, 0, owner=0, army=12, general=0)
            sim.tile(1, 0, owner=0, army=5)
            sim.tile(5, 6, owner=1, army=12, general=1)
            h = Harness(sim, seed=seed, game_id="eq2")
            h.prime()
            return h

        plain = build(13)
        with_auto = build(13)
        active = intent(goal("auto"), revision=1)
        for turn in range(2, 6):
            left = plain.step()
            right = with_auto.step(state(active))
            self.assertEqual(right["move"], left["move"], (turn, left, right))
            if left["move"]:
                plain.sim.apply_move(0, left["move"])
                with_auto.sim.apply_move(0, right["move"])
            else:
                plain.sim.advance()
                with_auto.sim.advance()

    def test_clear_after_auto_returns_to_original(self):
        def build(seed):
            sim = Sim(7, 7, players=2, seed=seed)
            sim.tile(0, 0, owner=0, army=12, general=0)
            sim.tile(1, 0, owner=0, army=5)
            sim.tile(5, 6, owner=1, army=12, general=1)
            h = Harness(sim, seed=seed, game_id="eq3")
            h.prime()
            return h

        plain = build(17)
        with_intent = build(17)
        active = intent(goal("auto"), revision=3)
        with_intent.step(state(active))
        plain.step()
        with_intent.sim.advance()
        plain.sim.advance()
        cleared = {"active": None, "status": "cancelled", "reason": "cleared_by_s2",
                   "lastRevision": 3, "lastRejection": None}
        right = with_intent.step(cleared)
        left = plain.step()
        self.assertIsNone(right["strategyFeedback"])
        self.assertEqual(right["task"]["kind"], "auto")
        self.assertEqual(right["move"], left["move"])


    def test_auto_preferences_choose_biased_one_step(self):
        def board():
            sim = Sim(9, 9, players=2, seed=23)
            sim.tile(0, 0, owner=0, army=5, general=0)
            sim.tile(4, 4, owner=0, army=10)
            sim.tile(5, 3, owner=0, army=6)
            sim.tile(5, 4, owner=-1, army=0, city=True)
            sim.tile(4, 3, owner=1, army=0, city=True)
            sim.tile(8, 8, owner=1, army=10, general=1)
            return sim

        economy = board()
        h = Harness(economy, seed=23)
        h.prime()
        out = h.step(state(intent(goal("auto"), revision=1,
                                  preferences={"emphasis": "economy", "risk": "normal"})))
        self.assertEqual(economy.xy(out["move"]["to"]), (5, 4))

        pressure = board()
        h = Harness(pressure, seed=23)
        h.prime()
        out = h.step(state(intent(goal("auto"), revision=1,
                                  preferences={"emphasis": "pressure", "risk": "normal"})))
        self.assertEqual(pressure.xy(out["move"]["to"]), (4, 3))


if __name__ == "__main__":
    unittest.main()
