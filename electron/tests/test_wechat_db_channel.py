import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import wechat_db_channel as channel


class ProgramOnStdinTest(unittest.TestCase):
    def test_sudo_command_line_stays_short_and_program_travels_on_stdin(self):
        reader = channel.DatabaseReader()
        source = (Path(channel.__file__).with_name("wechat_db_guest.py")).read_bytes()
        self.assertLess(len(reader.command[-1]), 300)
        self.assertNotIn("base64", reader.command[-1])
        self.assertEqual(reader.preamble, f"{len(source)}\n".encode() + source)
        completed = subprocess.CompletedProcess([], 0, stdout=b'{"ok":true}')
        with patch.object(channel.subprocess, "run", return_value=completed) as run:
            reader.read({"op": "discover"})
        sent = run.call_args.kwargs["input"]
        self.assertTrue(sent.startswith(reader.preamble))
        self.assertEqual(json.loads(sent[len(reader.preamble):]), {"op": "discover"})

    def test_bootstrap_runs_the_program_and_leaves_the_request_for_it(self):
        program = b'import json,sys\nrequest=json.loads(sys.stdin.buffer.readline())\nprint(json.dumps({"ok":True,"op":request["op"]}))\n'
        request = b'{"op":"discover"}\n'
        completed = subprocess.run([sys.executable, "-I", "-B", "-c", channel.BOOTSTRAP],
                                   input=f"{len(program)}\n".encode() + program + request,
                                   stdout=subprocess.PIPE, check=True, timeout=10)
        self.assertEqual(json.loads(completed.stdout), {"ok": True, "op": "discover"})


if __name__ == "__main__":
    unittest.main()
