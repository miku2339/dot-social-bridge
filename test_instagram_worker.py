import base64
from datetime import datetime, timezone
import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace
import unittest


MODULE_PATH = Path(__file__).with_name("instagram-worker.py")
SPEC = importlib.util.spec_from_file_location("instagram_worker", MODULE_PATH)
worker_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker_module)
LOGIN_SPEC = importlib.util.spec_from_file_location("login_instagram", Path(__file__).with_name("login-instagram.py"))
login_module = importlib.util.module_from_spec(LOGIN_SPEC)
LOGIN_SPEC.loader.exec_module(login_module)


BOT = "100"
PEER = "200"
OTHER = "300"
THREAD = "900"
NOW = datetime(2026, 10, 18, tzinfo=timezone.utc)


def message(message_id="m1", sender_id=PEER, *, kind="text", text="hello", from_me=False, **fields):
    values = {
        "id": message_id,
        "user_id": sender_id,
        "timestamp": NOW,
        "item_type": kind,
        "is_sent_by_viewer": from_me,
        "text": text,
        **fields,
    }
    return SimpleNamespace(**values)


def thread(*, thread_id=THREAD, group=False, messages=None, users=None):
    if users is None:
        users = [SimpleNamespace(pk=PEER)] if not group else [SimpleNamespace(pk=PEER), SimpleNamespace(pk=OTHER)]
    return SimpleNamespace(
        id=thread_id,
        is_group=group,
        thread_title="Friends" if group else "Direct",
        users=users,
        messages=list(messages or [message()]),
    )


class FakeClient:
    def __init__(self, *, account_id=BOT, account_error=None, direct_error=None):
        self.account_id = account_id
        self.account_error = account_error
        self.direct_error = direct_error
        self.account_calls = 0
        self.loaded = []
        self.threads = [thread()]
        self.thread_by_id = {THREAD: self.threads[0]}
        self.sent_text = []
        self.sent_images = []

    def load_settings(self, path):
        self.loaded.append(path)

    def account_info(self):
        self.account_calls += 1
        if self.account_error:
            raise self.account_error
        return SimpleNamespace(pk=self.account_id, username="bridge_bot")

    def direct_threads(self, *, amount, thread_message_limit):
        if self.direct_error:
            raise self.direct_error
        self.poll_args = (amount, thread_message_limit)
        return self.threads[:amount]

    def direct_thread(self, thread_id, *, amount):
        self.thread_args = (thread_id, amount)
        return self.thread_by_id[str(thread_id)]

    def direct_send(self, text, *, thread_ids):
        self.sent_text.append((text, thread_ids))
        return message("sent-text", BOT, text=text, from_me=True)

    def direct_send_photo(self, path, *, thread_ids):
        path = Path(path)
        self.sent_images.append((path, path.read_bytes(), thread_ids))
        return message("sent-image", BOT, kind="media", text=None, from_me=True)


class ChallengeRequired(Exception):
    pass


class LoginRequired(Exception):
    pass


class ClientThrottledError(Exception):
    def __init__(self):
        self.response = SimpleNamespace(status_code=429, headers={"Retry-After": "120"})


class ProviderFailure(Exception):
    pass


class WorkerTest(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name).resolve()
        self.session = self.data_dir / worker_module.SESSION_NAME
        self.session.write_text("{}", encoding="utf-8")
        self.session.chmod(0o600)

    def tearDown(self):
        self.temporary.cleanup()

    def worker(self, client):
        return worker_module.InstagramWorker(data_dir=str(self.data_dir), expected_user_id=BOT, client_factory=lambda: client)

    def request(self, worker, operation, **fields):
        return worker.handle({"id": "request-1", "operation": operation, **fields})

    def test_reuses_saved_session_and_rechecks_immutable_account(self):
        client = FakeClient()
        worker = self.worker(client)
        first = self.request(worker, "status")
        second = self.request(worker, "status")
        self.assertEqual(first["result"], {"status": "connected", "account": {"id": BOT, "username": "bridge_bot"}})
        self.assertEqual(second["result"]["status"], "connected")
        self.assertEqual(client.loaded, [str(self.session)])
        self.assertEqual(client.account_calls, 2)

        mismatch = self.worker(FakeClient(account_id=OTHER))
        self.assertEqual(self.request(mismatch, "status")["result"]["status"], "provider_error")
        denied = self.request(mismatch, "poll", limit=1)
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "provider_error")

    def test_missing_or_unsafe_session_is_nonfatal(self):
        self.session.unlink()
        worker = self.worker(FakeClient())
        self.assertEqual(self.request(worker, "status")["result"], {"status": "not_configured", "account": None})
        self.assertEqual(self.request(worker, "poll", limit=1)["error"]["code"], "not_configured")

        self.session.write_text("{}", encoding="utf-8")
        self.session.chmod(0o644)
        unsafe = self.worker(FakeClient())
        self.assertEqual(self.request(unsafe, "status")["result"]["status"], "provider_error")

    def test_challenge_login_and_rate_errors_are_bounded(self):
        challenged_client = FakeClient(account_error=ChallengeRequired("private challenge payload"))
        challenged = self.worker(challenged_client)
        self.assertEqual(self.request(challenged, "status")["result"]["status"], "challenge_required")
        self.assertEqual(self.request(challenged, "status")["result"]["status"], "challenge_required")
        self.assertEqual(challenged_client.account_calls, 1)

        mid_request_client = FakeClient(direct_error=ChallengeRequired("private challenge payload"))
        mid_request = self.worker(mid_request_client)
        self.assertEqual(self.request(mid_request, "poll", limit=1)["error"]["code"], "challenge_required")
        self.assertEqual(self.request(mid_request, "status")["result"]["status"], "challenge_required")
        self.assertEqual(mid_request_client.account_calls, 1)

        login = self.worker(FakeClient(account_error=LoginRequired("private session payload")))
        self.assertEqual(self.request(login, "poll", limit=1)["error"]["code"], "login_required")

        limited_client = FakeClient(account_error=ClientThrottledError())
        limited = self.worker(limited_client)
        status = self.request(limited, "status")["result"]
        self.assertEqual(status["status"], "rate_limited")
        self.assertEqual(status["retryAfter"], 120)
        self.assertEqual(self.request(limited, "poll", limit=1)["error"]["retryAfter"], 120)
        self.assertEqual(limited_client.account_calls, 2)

        transient_client = FakeClient(account_error=ProviderFailure("private provider payload"))
        transient = self.worker(transient_client)
        first = self.request(transient, "status")
        self.assertEqual(first["result"]["status"], "provider_error")
        self.assertNotIn("private provider payload", str(first))
        transient_client.account_error = None
        self.assertEqual(self.request(transient, "status")["result"]["status"], "connected")

    def test_replaced_session_clears_a_latched_login_failure(self):
        expired = FakeClient(account_error=LoginRequired("private session payload"))
        connected = FakeClient()
        clients = iter([expired, connected])
        worker = worker_module.InstagramWorker(
            data_dir=str(self.data_dir),
            expected_user_id=BOT,
            client_factory=lambda: next(clients),
        )
        self.assertEqual(self.request(worker, "status")["result"]["status"], "login_required")
        self.session.unlink()
        self.session.write_text('{"new":true}', encoding="utf-8")
        self.session.chmod(0o600)
        self.assertEqual(self.request(worker, "status")["result"]["status"], "connected")
        self.assertEqual(connected.loaded, [str(self.session)])

    def test_poll_normalizes_dm_group_and_ignores_actions(self):
        image = SimpleNamespace(media_type=1, thumbnail_url="https://cdn.example/private.jpg")
        client = FakeClient()
        client.threads = [
            thread(messages=[message(), message("reaction", kind="reaction", text="heart"), message("empty", kind="link", text="")]),
            thread(thread_id="901", group=True, messages=[message("photo", kind="media", text=None, media=image)]),
        ]
        client.thread_by_id = {item.id: item for item in client.threads}
        result = self.request(self.worker(client), "poll", limit=2)["result"]
        self.assertEqual(client.poll_args, (2, 20))
        self.assertEqual(result["account"]["id"], BOT)
        self.assertEqual(result["threads"][0]["memberIds"], [PEER, BOT])
        self.assertEqual([item["id"] for item in result["threads"][0]["messages"]], ["m1"])
        group = result["threads"][1]
        self.assertEqual(group["memberIds"], [PEER, OTHER, BOT])
        self.assertEqual(group["messages"][0]["mediaType"], "image")
        self.assertEqual(group["messages"][0]["media"]["url"], "https://cdn.example/private.jpg")

    def test_strict_request_bounds_and_thread_membership(self):
        worker = self.worker(FakeClient())
        for request in (
            {"id": "x", "operation": "poll", "limit": 0},
            {"id": "x", "operation": "poll", "limit": 21},
            {"id": "x", "operation": "status", "extra": True},
            {"id": "x", "operation": "thread", "threadId": "../x", "limit": 1},
        ):
            result = worker.handle(request)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "invalid_request")

        bad_client = FakeClient()
        bad_client.threads = [thread(users=[SimpleNamespace(pk=PEER), SimpleNamespace(pk=OTHER)])]
        bad_client.thread_by_id = {THREAD: bad_client.threads[0]}
        bad = self.request(self.worker(bad_client), "poll", limit=1)
        self.assertEqual(bad["error"]["code"], "provider_error")

    def test_send_text_requires_same_stored_fresh_source(self):
        client = FakeClient()
        worker = self.worker(client)
        before_read = self.request(worker, "send_text", threadId=THREAD, sourceMessageId="m1", text="reply")
        self.assertEqual(before_read["error"]["code"], "invalid_request")
        self.request(worker, "thread", threadId=THREAD, limit=20)
        sent = self.request(worker, "send_text", threadId=THREAD, sourceMessageId="m1", text="reply")
        self.assertEqual(sent["result"], {"messageId": "sent-text", "timestamp": int(NOW.timestamp() * 1000)})
        self.assertEqual(client.sent_text, [("reply", [int(THREAD)])])

        client.thread_by_id[THREAD] = thread(messages=[message("m1", OTHER)], users=[SimpleNamespace(pk=PEER)])
        rejected = self.request(worker, "send_text", threadId=THREAD, sourceMessageId="m1", text="again")
        self.assertEqual(rejected["error"]["code"], "invalid_request")
        self.assertEqual(len(client.sent_text), 1)

        client.thread_by_id[THREAD] = thread(messages=[message("m1", PEER, text="changed")])
        changed = self.request(worker, "send_text", threadId=THREAD, sourceMessageId="m1", text="again")
        self.assertEqual(changed["error"]["code"], "invalid_request")
        self.assertEqual(len(client.sent_text), 1)

    def test_send_image_verifies_bytes_and_cleans_temporary_file(self):
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(buffer, format="PNG")
        png = buffer.getvalue()
        client = FakeClient()
        worker = self.worker(client)
        self.request(worker, "thread", threadId=THREAD, limit=20)
        sent = self.request(
            worker,
            "send_image",
            threadId=THREAD,
            sourceMessageId="m1",
            data=base64.b64encode(png).decode(),
            mimetype="image/png",
        )
        self.assertEqual(sent["result"]["messageId"], "sent-image")
        path, saved, thread_ids = client.sent_images[0]
        self.assertEqual(saved, png)
        self.assertEqual(thread_ids, [int(THREAD)])
        self.assertFalse(path.exists())
        self.assertFalse(path.parent.exists())

        invalid = self.request(
            worker,
            "send_image",
            threadId=THREAD,
            sourceMessageId="m1",
            data=base64.b64encode(b"not-image").decode(),
            mimetype="image/png",
        )
        self.assertEqual(invalid["error"]["code"], "invalid_request")
        self.assertEqual(len(client.sent_images), 1)

    def test_login_helper_saves_only_atomic_private_json(self):
        class DumpClient:
            def dump_settings(self, path):
                Path(path).write_text('{"authorization_data":{"ds_user_id":"100"}}', encoding="utf-8")
                return True

        target = login_module._write_session(DumpClient(), self.data_dir)
        self.assertEqual(target, self.session)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.data_dir.glob(".instagram-session-*")), [])

        target.unlink()
        target.symlink_to(self.data_dir / "must-not-be-written")
        with self.assertRaisesRegex(RuntimeError, "unsafe"):
            login_module._write_session(DumpClient(), self.data_dir)
        self.assertFalse((self.data_dir / "must-not-be-written").exists())


if __name__ == "__main__":
    unittest.main()
