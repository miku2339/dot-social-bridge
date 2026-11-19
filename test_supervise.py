import fcntl
import json
from pathlib import Path
import signal
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import supervise
from supervise import filter_bridge_log_chunk, filter_bridge_log_line


class SupervisorStopTest(unittest.TestCase):
    def test_stop_waits_for_old_supervisor_to_release_its_lock(self):
        with TemporaryDirectory() as directory:
            shared = Path(directory)
            pidfile = shared / "supervisor.pid"
            pidfile.write_text("1234")
            with (shared / "supervisor.lock").open("a") as old_lock:
                fcntl.flock(old_lock, fcntl.LOCK_EX)

                def finish_shutdown(_delay):
                    pidfile.unlink()
                    fcntl.flock(old_lock, fcntl.LOCK_UN)

                with (
                    patch.object(supervise, "PIDFILE", pidfile),
                    patch.object(supervise, "SHARED", shared),
                    patch.object(Path, "read_bytes", return_value=bytes(supervise.BASE / "supervise.py") + b"\0"),
                    patch.object(supervise.os, "kill") as kill,
                    patch.object(supervise.time, "sleep", side_effect=finish_shutdown),
                ):
                    supervise.stop_existing()
                kill.assert_called_once_with(1234, signal.SIGTERM)
                with (shared / "supervisor.lock").open() as new_lock:
                    fcntl.flock(new_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


class BridgeLogFilterTest(unittest.TestCase):
    def test_discards_raw_signal_session_dump(self):
        raw = "Closing open session: SessionRecord { _state: { rootKey: <Buffer de ad be ef> } }"
        self.assertIsNone(filter_bridge_log_line(raw))

    def test_keeps_only_allowlisted_scalar_metadata(self):
        source = {
            "level": 30,
            "time": 1_800_000_000_000,
            "pid": 1234,
            "port": 4391,
            "host": "127.0.0.1",
            "msg": "private WhatsApp MCP listening",
            "errorName": "SecretMaterial",
            "errorCode": "private-ciphertext",
            "text": "private message body",
            "qr": "private-qr",
            "creds": {"me": {"id": "private-account"}, "privateKey": "private-key"},
            "session": {"rootKey": "root-key", "chainKey": "chain-key"},
            "err": {"message": "error containing private payload", "data": {"secret": "secret"}},
        }

        filtered = filter_bridge_log_line(json.dumps(source))

        self.assertEqual(json.loads(filtered), {
            "level": 30,
            "time": 1_800_000_000_000,
            "pid": 1234,
            "port": 4391,
            "host": "127.0.0.1",
            "msg": "private WhatsApp MCP listening",
        })
        for secret in ("private message body", "private-qr", "private-key", "root-key", "chain-key", "private payload", "SecretMaterial", "private-ciphertext"):
            self.assertNotIn(secret, filtered)

        safe_error = filter_bridge_log_line(json.dumps({
            "level": 50,
            "msg": "request failed",
            "errorName": "Error",
            "errorCode": "ECONNRESET",
            "dropped": 2,
        }))
        self.assertEqual(json.loads(safe_error), {
            "level": 50,
            "dropped": 2,
            "errorName": "Error",
            "errorCode": "ECONNRESET",
            "msg": "request failed",
        })

    def test_buffers_partial_json_and_never_returns_raw_lines(self):
        safe = json.dumps({"level": 40, "msg": "event publish failed", "session": {"key": "secret"}}).encode()
        remainder, records = filter_bridge_log_chunk(b"", b"raw Signal session dump\n" + safe[:12])
        self.assertEqual(records, [])

        remainder, records = filter_bridge_log_chunk(remainder, safe[12:] + b"\n")
        self.assertEqual(remainder, b"")
        self.assertEqual(records, ['{"level":40,"msg":"event publish failed"}'])
        self.assertNotIn("secret", records[0])

    def test_discards_malformed_or_unexpected_metadata_without_raising(self):
        unexpected = json.dumps({
            "level": 10**100,
            "time": -1,
            "pid": 0,
            "dropped": 10**100,
            "host": {"secret": "host"},
            "msg": ["private message"],
            "errorName": {"secret": "name"},
            "errorCode": 10**100,
            "session": {"rootKey": "root-key"},
        })
        self.assertIsNone(filter_bridge_log_line(unexpected))
        self.assertIsNone(filter_bridge_log_line("x" * (64 * 1024 + 1)))
        self.assertIsNone(filter_bridge_log_line('{"level":' + "9" * 10_000 + "}"))
        self.assertIsNone(filter_bridge_log_line("[" * 2_000 + "0" + "]" * 2_000))


if __name__ == "__main__":
    unittest.main()
