"""One JSONL request per stdin line, one reply on stdout, exceptions on stderr."""
import json
import sys
import time
import traceback


class Channel:
    def __init__(self):
        self._in = sys.stdin

    def recv(self):
        line = self._in.readline()
        if not line:
            return None
        line = line.strip()
        return json.loads(line) if line else {}

    def send(self, payload):
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def run(init_handler, step_handler, close_handler=None, implementation="unknown"):
    """Serve init/step/close until stdin closes. Returns the process exit code.

    The init handler may return a string (the implementation name) or a dict of
    response fields to merge, so an adapter can report `warmupMs` measured before
    the first real turn.
    """
    channel = Channel()
    while True:
        request = channel.recv()
        if request is None:
            return 0
        if not request:
            continue
        request_id = request.get("id")
        kind = request.get("kind")
        try:
            if kind == "init":
                detail = init_handler(request)
                response = {"id": request_id, "ready": True, "implementation": implementation}
                if isinstance(detail, dict):
                    response.update(detail)
                elif detail:
                    response["implementation"] = detail
                channel.send(response)
            elif kind == "step":
                started = time.perf_counter()
                result = step_handler(request)
                elapsed_ms = round((time.perf_counter() - started) * 1000.0, 3)
                if isinstance(result, dict) and "move" in result:
                    # The adapter can add fields the protocol allows, such as a surrender flag.
                    response = {"id": request_id, "computeMs": elapsed_ms, **result}
                else:
                    response = {"id": request_id, "move": result, "computeMs": elapsed_ms}
                channel.send(response)
            elif kind == "close":
                if close_handler is not None:
                    close_handler()
                channel.send({"id": request_id, "closed": True})
                return 0
            else:
                channel.send({"id": request_id, "move": None, "error": "unknown_kind: %r" % (kind,)})
        except Exception as exc:  # the adapter reports failures, it does not crash the harness
            sys.stderr.write("adapter error: %s: %s\n" % (type(exc).__name__, exc))
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            channel.send({"id": request_id, "move": None, "error": "%s: %s" % (type(exc).__name__, exc)})


def index_to_row_col(index, width):
    """Flat row-major index to (row, col)."""
    return index // width, index % width


def row_col_to_index(row, col, width):
    return row * width + col
