"""Subprocess fixture for timeout and invalid JSON at the transport boundary."""
import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    if request["kind"] == "delay":
        time.sleep(30)
    else:
        print("invalid-json", flush=True)
