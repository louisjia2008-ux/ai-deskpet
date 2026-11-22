"""Keep historical Python audits on the Core doctor's stationary rule."""
import json
import os
from pathlib import Path
import subprocess

TOOLS = Path(__file__).resolve().parent
NODE = os.environ.get("NODE_BINARY", "node")
REPLAY = TOOLS / "doctor-replay.js"
RULE = TOOLS.parent / "core" / "doctor-stationary.js"
MAX_GAP = int(subprocess.check_output(
    [NODE, "-p", "require(process.argv[1]).D1.maxGapMs", str(RULE)], text=True))


def stationary(rows, _body):
    """The archived callers derive body events from rows. Replay rows once."""
    source = "".join(json.dumps(row) + "\n" for row in rows)
    completed = subprocess.run([NODE, str(REPLAY), "--stationary-stdin"],
                               input=source, text=True, capture_output=True, check=True)
    report = json.loads(completed.stdout)
    return report["stationarySegments"], report["missingSamples"]


def exclusions_during_trap(body, exclusions, spans, finish):
    stuck, active, revoked = [], None, set()
    for e in body:
        at, kind = e.get("at"), e.get("type")
        if not isinstance(at, (int, float)):
            continue
        if kind == "self_stuck" and active is None:
            active = e.get("since", at)
        elif kind in ("self_stuck_escaped", "autonomy_death") and active is not None:
            stuck.append((active, at))
            active = None
        elif kind == "target_failure_revoked" and e.get("excluded"):
            revoked.add((e.get("key"), at))
    if active is not None and finish is not None:
        stuck.append((active, finish))
    # Older candidates had no self_stuck event. Mark exclusions during a
    # stationary interval separately as retrospective, not as live detections.
    for e in exclusions:
        at = e["at"]
        end = next((end for start, end in stuck if start <= at <= end), None)
        e["self_stuck"] = end is not None
        e["stationary_origin"] = any(s["at"] <= at <= s["finish"] for s in spans)
        e["revoked"] = end is not None and any(key == e["key"] and at <= when <= end for key, when in revoked)
