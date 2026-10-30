import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
for path in (IMPL, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from sim import Harness, Sim


def board(general_army, threat=112, city_owner=0, city=True, extra=0, threat_visible=True):
    """General 0, adjacent destination 9, threat at 1; decision is after even production."""
    sim = Sim(9, 9, players=2)
    sim.tile(0, 0, owner=0, army=general_army - 1, general=0)
    sim.tile(0, 1, owner=city_owner, army=1, city=city)
    if threat_visible:
        sim.tile(1, 0, owner=1, army=threat)
    if extra:
        sim.tile(8, 0, owner=0, army=extra)
    sim.tile(8, 8, owner=1, army=10, general=1)
    h = Harness(sim)
    h.prime()
    return h


def constraints(h):
    backend = h.adapter.backend
    value = backend._parse_constraints({"constraints": {}})
    backend._apply_half_edges(h.adapter.game, value)
    return backend, value


class CityHalfTest(unittest.TestCase):
    def test_general_to_owned_city_is_half_and_keeps_324(self):
        h = board(647)
        h.step()
        backend, c = constraints(h)
        self.assertIn((0, 9), c.half_edges, h.step()["diagnostics"])
        move = backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal")
        self.assertEqual(move, {"from": 0, "to": 9, "half": True}, move)
        sent = backend.obs.army(0) // 2
        self.assertEqual(sent, 323)
        self.assertEqual(backend.obs.army(0) - sent, 324)
        pending = backend._make_pending(move, 1)
        self.assertEqual(pending["sent"], 323)

    def test_general_to_owned_normal_tile_keeps_original_split(self):
        h = board(647, city=False)
        h.step()
        backend, c = constraints(h)
        self.assertNotIn((0, 9), c.half_edges)
        move = backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal")
        self.assertFalse(move["half"], move)

    def test_no_current_demand_keeps_original_split(self):
        h = board(647, threat_visible=False)
        h.step()
        backend, c = constraints(h)
        self.assertEqual(c.half_edges, set())
        move = backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal")
        self.assertFalse(move["half"], move)

    def test_general_180_to_city_sends_90_and_keeps_90(self):
        h = board(180)
        h.step()
        backend, c = constraints(h)
        move = backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal")
        self.assertTrue(move["half"], move)
        sent = backend.obs.army(0) // 2
        self.assertEqual(sent, 90)
        self.assertEqual(backend.obs.army(0) - sent, 90)

    def test_enemy_and_neutral_city_do_not_trigger(self):
        for owner in (None, 1):
            h = board(647, city_owner=owner)
            h.step()
            backend, c = constraints(h)
            self.assertNotIn((0, 9), c.half_edges)
            # Enemy/neutral city is not an ordinary own-city edge.
            self.assertFalse(any(dest == 9 for _, dest in c.half_edges))

    def test_unreachable_or_fog_threat_does_not_trigger(self):
        # Threat outside the configured reach/horizon: no current demand, so no city edge.
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=646, general=0)
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.tile(8, 1, owner=1, army=112)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend, c = constraints(h)
        self.assertEqual(c.half_edges, set())

        # A threat that is no longer current self/enemy is absent from demand.
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=646, general=0)
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.tile(1, 0, owner=1, army=112)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        h.sim.tile(1, 0, owner=None, army=0)
        h.sim.advance()
        h.step()
        backend, c = constraints(h)
        self.assertEqual(c.half_edges, set())

    def test_donor_path_through_general_uses_half_on_city_edge(self):
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=99, general=0)
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.tile(2, 0, owner=0, army=30)
        sim.tile(1, 0, owner=0, army=1)
        sim.mountain(1, 1)
        sim.tile(0, 2, owner=1, army=112)
        sim.tile(4, 4, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend, c = constraints(h)
        plan = backend._plan_path(h.adapter.game, 2, 5, c, "normal")
        self.assertEqual(plan["path"], [2, 1, 0, 5], plan)
        self.assertEqual(plan["splits"], [False, False, True], plan)
        self.assertTrue(plan["feasible"], plan)
        self.assertEqual(plan["delivered"], 64, plan)

    def test_half_rejected_does_not_fall_back_to_full(self):
        h = board(647)
        h.step()
        backend = h.adapter.backend
        c = backend._parse_constraints({"constraints": {
            "reserves": [{"tile": {"x": 0, "y": 0}, "armies": 400}]}})
        backend._apply_half_edges(h.adapter.game, c)
        self.assertIn((0, 9), c.half_edges)
        self.assertIsNone(backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal"))

    def test_explicit_avoid_blocks_the_forced_half_edge(self):
        h = board(647)
        h.step()
        backend = h.adapter.backend
        c = backend._parse_constraints({"constraints": {
            "avoidTiles": [{"x": 0, "y": 1}]}})
        backend._apply_half_edges(h.adapter.game, c)
        self.assertIn((0, 9), c.half_edges)
        self.assertIsNone(backend._choose_move(h.adapter.game, 0, 9, c, set(), "normal"))

    def test_native_candidate_half_does_not_claim_full_feasible(self):
        from native_candidate import build_native_candidate
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=646, general=0)  # 647 at decision
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.tile(1, 0, owner=1, army=112)
        sim.tile(0, 2, owner=1, army=500, city=True)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend, c = constraints(h)
        candidate = build_native_candidate(backend.obs, h.adapter.game, "capture_city",
                                           sim.idx(0, 2), c, "normal")
        self.assertFalse(candidate["full_feasible"], candidate)

    def test_auto_raw_full_from_general_is_rechecked_as_half(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=646, general=0)
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.mountain(1, 0)
        sim.tile(0, 2, owner=1, army=112)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        out = h.step()
        self.assertTrue(out["move"]["half"], out)
        self.assertEqual(out["diagnostics"]["autoAdjustment"]["rawProposal"]["half"], False)
        self.assertEqual(out["diagnostics"]["autoAdjustment"]["reason"], "city_half_only")
        self.assertEqual(out["diagnostics"]["cityHalfApplied"]["sent"], 323)
        self.assertEqual(out["diagnostics"]["cityHalfApplied"]["remaining"], 324)

    def test_auto_half_rejection_keeps_concrete_hard_reason(self):
        sim = Sim(9, 9, players=2)
        sim.tile(0, 0, owner=0, army=646, general=0)
        sim.tile(0, 1, owner=0, army=1, city=True)
        sim.mountain(1, 0)
        sim.tile(0, 2, owner=1, army=112)
        sim.tile(8, 8, owner=1, army=10, general=1)
        h = Harness(sim)
        h.prime()
        h.step()
        backend = h.adapter.backend
        c = backend._parse_constraints({"constraints": {
            "reserves": [{"tile": {"x": 0, "y": 0}, "armies": 400}]}})
        backend._apply_half_edges(h.adapter.game, c)
        backend._auto_move(h.adapter.game, c, {64}, set(), None)
        self.assertEqual(backend.last_auto_rejected, "strategy_reserve")
        self.assertEqual(backend.last_auto_adjustment["rejected"], "strategy_reserve")
        self.assertEqual(backend.last_auto_adjustment["reason"],
                         "city_half_rejected:strategy_reserve")

    def test_no_demand_wait_stays_wait(self):
        # A blocked general with no city destination and no usable action still waits.
        sim = Sim(5, 5, players=2)
        sim.tile(0, 0, owner=0, army=10, general=0)
        sim.tile(0, 1, owner=1, army=100)
        sim.tile(1, 0, owner=1, army=100)
        sim.tile(4, 4, owner=1, army=10, general=1)
        for y in range(5):
            for x in range(5):
                index = y * 5 + x
                if index not in (0, 1, 5, 24):
                    sim.mountain(x, y)
        h = Harness(sim)
        h.prime()
        out = h.step()
        self.assertIsNone(out["move"], out)
