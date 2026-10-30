import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMPL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "agent", "city-half"))
ADAPTER = os.path.join(IMPL, "adapter.py")


def observation(turn):
    width = height = 5
    terrain = [-1] * (width * height)
    armies = [0] * (width * height)
    terrain[0], armies[0] = 0, 10
    terrain[1], armies[1] = 0, 3
    terrain[24], armies[24] = 1, 10
    return {"width": width, "height": height, "playerIndex": 0, "playerCount": 2, "turn": turn,
            "armies": armies, "terrain": terrain, "cities": [], "generals": [0, 24],
            "scores": [{"i": 0, "total": 13, "tiles": 2, "dead": False},
                       {"i": 1, "total": 10, "tiles": 1, "dead": False}], "teams": [0, 1]}


class IpcTest(unittest.TestCase):
    def test_init_step_close_round_trip(self):
        env = dict(os.environ)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        process = subprocess.Popen(
            [sys.executable, ADAPTER], cwd=IMPL, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        intent = {"gameId": "ipc", "controlEpoch": 1, "revision": 1, "basedOnTurn": 0,
                  "expiresTurn": 99, "goal": {"kind": "capture_city", "target": {"x": 0, "y": 4}}}
        requests = [
            {"kind": "init", "id": 1, "gameId": "ipc", "playerIndex": 0, "playerCount": 2,
             "width": 5, "height": 5, "mode": "standard", "seed": 3},
            {"kind": "step", "id": 2, "observation": observation(1)},
            {"kind": "step", "id": 3, "observation": observation(2),
             "context": {"gameId": "ipc", "controlEpoch": 1, "revision": 2},
             "strategy": {"active": intent, "status": "following", "reason": None,
                          "lastRevision": 1, "lastRejection": None}},
            {"kind": "close", "id": 4},
        ]
        payload = "".join(json.dumps(request) + "\n" for request in requests)
        stdout, stderr = process.communicate(payload, timeout=60)
        self.assertEqual(process.returncode, 0, stderr)
        lines = [json.loads(line) for line in stdout.strip().splitlines()]
        by_id = {line["id"]: line for line in lines}
        self.assertTrue(by_id[1]["ready"])
        self.assertIn("auto", by_id[1]["capabilities"]["goals"])
        self.assertEqual(by_id[2]["task"]["kind"], "auto")
        self.assertEqual(by_id[3]["task"]["kind"], "capture_city")
        self.assertEqual(by_id[3]["task"]["target"], 4 * 5 + 0)
        self.assertTrue(by_id[4]["closed"])


if __name__ == "__main__":
    unittest.main()
