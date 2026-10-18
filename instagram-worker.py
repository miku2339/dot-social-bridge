#!/usr/bin/env python3
"""Bounded JSONL worker for an optional private Instagram connection."""

from __future__ import annotations

import base64
import binascii
from collections import OrderedDict
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
from typing import Any, Callable


MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_SESSION_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 40_000_000
MAX_CACHED_SOURCES = 2000
SESSION_NAME = "instagram-private-session.json"
NUMERIC_ID = re.compile(r"^[1-9][0-9]{0,63}$")
SAFE_MESSAGE_ID = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")
TEXT_KINDS = frozenset({"text", "link", "xma_link"})
IGNORED_KINDS = frozenset({"action_log", "like", "reaction"})
MEDIA_KINDS = {
    "animated_media": "image",
    "clip": "video",
    "file": "document",
    "media": None,
    "media_share": None,
    "raven_media": None,
    "story_share": None,
    "visual_media": None,
    "voice_media": "audio",
    "xma_clip": "video",
    "xma_media_share": None,
}
ERROR_CODES = frozenset({
    "not_configured",
    "login_required",
    "challenge_required",
    "rate_limited",
    "provider_error",
    "invalid_request",
})


class _DiscardText(io.TextIOBase):
    def write(self, value: str) -> int:
        return len(value)

    def flush(self) -> None:
        return None


DISCARD = _DiscardText()


class WorkerError(Exception):
    def __init__(self, code: str, message: str, *, retry_after: int | None = None, latch: bool = False):
        if code not in ERROR_CODES:
            code = "provider_error"
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.retry_after = retry_after
        self.latch = latch


def _value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, dict):
        return source.get(name, default)
    return getattr(source, name, default)


def _numeric_id(value: Any, label: str) -> str:
    result = str(value) if value is not None else ""
    if not NUMERIC_ID.fullmatch(result):
        raise WorkerError("provider_error", f"Instagram returned an invalid {label}.")
    return result


def _request_numeric_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not NUMERIC_ID.fullmatch(value):
        raise WorkerError("invalid_request", f"{label} is invalid.")
    return value


def _safe_string(value: Any, maximum: int, *, empty: bool = False) -> str | None:
    if not isinstance(value, str) or len(value) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    value = value.strip()
    if not value and not empty:
        return None
    return value


def _timestamp_ms(value: Any) -> int:
    if isinstance(value, datetime):
        current = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        result = int(current.timestamp() * 1000)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        result = int(value)
        if result < 10_000_000_000:
            result *= 1000
        elif result > 10_000_000_000_000:
            result //= 1000
    else:
        raise WorkerError("provider_error", "Instagram returned an invalid message timestamp.")
    if result < 0 or result > 100_000_000_000_000:
        raise WorkerError("provider_error", "Instagram returned an invalid message timestamp.")
    return result


def _retry_after(error: Exception) -> int | None:
    candidates = [getattr(error, "retry_after", None)]
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is not None:
        try:
            candidates.append(headers.get("Retry-After"))
        except Exception:
            pass
    for candidate in candidates:
        try:
            result = int(float(candidate))
        except (TypeError, ValueError, OverflowError):
            continue
        if 1 <= result <= 86_400:
            return result
    return None


def _classify_provider_error(error: Exception) -> WorkerError:
    names = {base.__name__ for base in type(error).__mro__}
    status = getattr(getattr(error, "response", None), "status_code", None)
    if names & {"ChallengeError", "ChallengeRequired", "ChallengeRedirection", "ChallengeSelfieCaptcha", "ChallengeUnknownStep", "TwoFactorRequired"}:
        return WorkerError("challenge_required", "Instagram requires manual verification in the official app.")
    if names & {"ClientLoginRequired", "LoginRequired", "ReloginAttemptExceeded", "BadPassword", "BadCredentials"} or isinstance(error, AssertionError):
        return WorkerError("login_required", "The saved Instagram session is no longer valid.")
    if status == 429 or names & {"ClientThrottledError", "RateLimitError", "PleaseWaitFewMinutes"}:
        return WorkerError("rate_limited", "Instagram temporarily limited requests.", retry_after=_retry_after(error))
    return WorkerError("provider_error", "Instagram request failed.")


def _provider_call(callback: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        with redirect_stdout(DISCARD), redirect_stderr(DISCARD):
            return callback(*args, **kwargs)
    except WorkerError:
        raise
    except Exception as error:
        raise _classify_provider_error(error) from None


def _session_stat(path: Path) -> tuple[int, int, int]:
    try:
        file_stat = path.lstat()
    except FileNotFoundError:
        raise WorkerError("not_configured", "Instagram has not been connected.") from None
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise WorkerError("provider_error", "The Instagram session file is unsafe.")
    if stat.S_IMODE(file_stat.st_mode) != 0o600 or file_stat.st_size < 2 or file_stat.st_size > MAX_SESSION_BYTES:
        raise WorkerError("provider_error", "The Instagram session file is unsafe.")
    return file_stat.st_ino, file_stat.st_size, file_stat.st_mtime_ns


def _resolve_data_dir(value: str | None) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        result = Path(value).expanduser().resolve(strict=True)
        directory_stat = result.stat()
    except (OSError, RuntimeError):
        return None
    if not stat.S_ISDIR(directory_stat.st_mode):
        return None
    return result


def _extract_url(source: Any, depth: int = 0) -> str | None:
    if source is None or depth > 5:
        return None
    if isinstance(source, str):
        try:
            from urllib.parse import urlsplit

            parsed = urlsplit(source)
        except (TypeError, ValueError):
            return None
        if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and len(source) <= 4096 and not any(ord(char) <= 32 or ord(char) == 127 for char in source):
            return source
        return None
    if isinstance(source, (list, tuple)):
        for item in source[:20]:
            found = _extract_url(item, depth + 1)
            if found:
                return found
        return None
    keys = ("url", "video_url", "audio_url", "thumbnail_url", "preview_url", "download_url", "src")
    for key in keys:
        found = _extract_url(_value(source, key), depth + 1)
        if found:
            return found
    for key in ("media", "image_versions2", "candidates", "video_versions", "fallback", "visual_media", "file"):
        found = _extract_url(_value(source, key), depth + 1)
        if found:
            return found
    return None


def _media_type(message: Any, kind: str, media_source: Any) -> str:
    declared = MEDIA_KINDS.get(kind)
    if declared:
        return declared
    numeric = _value(media_source, "media_type")
    if numeric is None:
        numeric = _value(_value(media_source, "media"), "media_type")
    if numeric == 1:
        return "image"
    if numeric == 2:
        return "video"
    if _value(media_source, "audio_url"):
        return "audio"
    if _value(media_source, "video_url"):
        return "video"
    if _value(media_source, "video_versions") or _value(_value(media_source, "media"), "video_versions"):
        return "video"
    if (
        _value(media_source, "thumbnail_url")
        or _value(media_source, "preview_url")
        or _value(media_source, "image_versions2")
        or _value(_value(media_source, "media"), "image_versions2")
    ):
        return "image"
    return "document"


class InstagramWorker:
    def __init__(
        self,
        *,
        data_dir: str | None = None,
        expected_user_id: str | None = None,
        expected_username: str | None = None,
        client_factory: Callable[[], Any] | None = None,
    ):
        self.data_dir = _resolve_data_dir(data_dir)
        self.expected_user_id = expected_user_id if isinstance(expected_user_id, str) and NUMERIC_ID.fullmatch(expected_user_id) else None
        self.expected_username = _safe_string(expected_username, 100) if expected_username else None
        self.session_path = self.data_dir / SESSION_NAME if self.data_dir else None
        self.client_factory = client_factory
        self.client = None
        self.account: dict[str, str] | None = None
        self.blocked: WorkerError | None = None
        self.session_signature: tuple[int, int, int] | None = None
        self.sources: OrderedDict[tuple[str, str], tuple[Any, ...]] = OrderedDict()

    @classmethod
    def from_environment(cls) -> "InstagramWorker":
        return cls(
            data_dir=os.environ.get("DATA_DIR"),
            expected_user_id=os.environ.get("INSTAGRAM_EXPECTED_USER_ID"),
            expected_username=os.environ.get("INSTAGRAM_EXPECTED_USERNAME"),
        )

    def _new_client(self) -> Any:
        if self.client_factory is not None:
            return self.client_factory()
        try:
            with redirect_stdout(DISCARD), redirect_stderr(DISCARD):
                from instagrapi import Client

                client = Client()
        except Exception as error:
            raise _classify_provider_error(error) from None
        logger = logging.getLogger("instagram-private-worker")
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        logger.disabled = True
        try:
            client.logger = logger
        except Exception:
            pass
        return client

    def _configuration_error(self) -> WorkerError | None:
        if self.data_dir is None or self.expected_user_id is None or self.session_path is None:
            return WorkerError("not_configured", "Instagram has not been configured.")
        return None

    def _reset_if_session_changed(self) -> None:
        if self.session_path is None or self.session_signature is None:
            return
        try:
            current = _session_stat(self.session_path)
        except WorkerError:
            current = None
        if current != self.session_signature:
            self.client = None
            self.account = None
            self.blocked = None
            self.session_signature = None
            self.sources.clear()

    def _verified_account(self, client: Any) -> dict[str, str]:
        raw = self._provider(client.account_info)
        account_id = _numeric_id(_value(raw, "pk"), "account ID")
        if account_id != self.expected_user_id:
            raise WorkerError("provider_error", "Instagram account does not match the configured identity.", latch=True)
        username = _safe_string(_value(raw, "username"), 100) or self.expected_username or "Instagram"
        return {"id": account_id, "username": username}

    def _latch_failure(self, error: WorkerError) -> None:
        if error.code not in {"login_required", "challenge_required"} and not error.latch:
            return
        self.blocked = error
        try:
            self.session_signature = _session_stat(self.session_path)
        except WorkerError:
            self.session_signature = None

    def _provider(self, callback: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        try:
            return _provider_call(callback, *args, **kwargs)
        except WorkerError as error:
            self._latch_failure(error)
            raise

    def _require_client(self, *, fresh: bool = True) -> Any:
        configuration = self._configuration_error()
        if configuration:
            raise configuration
        self._reset_if_session_changed()
        if self.blocked:
            raise self.blocked
        try:
            signature = _session_stat(self.session_path)
            if self.client is None:
                client = self._new_client()
                self._provider(client.load_settings, str(self.session_path))
                self.account = self._verified_account(client)
                self.client = client
                self.session_signature = signature
            elif fresh:
                self.account = self._verified_account(self.client)
            return self.client
        except WorkerError as error:
            self._latch_failure(error)
            raise

    def status(self) -> dict[str, Any]:
        try:
            self._require_client(fresh=True)
            return {"status": "connected", "account": dict(self.account)}
        except WorkerError as error:
            result: dict[str, Any] = {"status": error.code, "account": None}
            if error.retry_after is not None:
                result["retryAfter"] = error.retry_after
            return result

    def _remember(self, thread: dict[str, Any]) -> None:
        for message in thread["messages"]:
            key = (thread["id"], message["id"])
            self.sources[key] = self._source_fingerprint(message)
            self.sources.move_to_end(key)
        while len(self.sources) > MAX_CACHED_SOURCES:
            self.sources.popitem(last=False)

    def _source_fingerprint(self, message: dict[str, Any]) -> tuple[Any, ...]:
        media = message.get("media")
        media_shape = None
        if isinstance(media, dict):
            media_shape = (media.get("mimetype"), media.get("fileName"))
        text_digest = hashlib.sha256((message.get("text") or "").encode("utf-8")).hexdigest()
        return (
            message.get("senderId"),
            message.get("timestamp"),
            message.get("fromMe"),
            message.get("mediaType"),
            media_shape,
            message.get("replyToMessageId"),
            text_digest,
        )

    def _normalize_message(self, message: Any, member_ids: set[str], thread_id: str) -> dict[str, Any] | None:
        message_id = _value(message, "id")
        if not isinstance(message_id, str) or not SAFE_MESSAGE_ID.fullmatch(message_id):
            return None
        raw_kind = _value(message, "item_type")
        kind = raw_kind.lower() if isinstance(raw_kind, str) else ""
        if kind in IGNORED_KINDS:
            return None
        text = _value(message, "text")
        if isinstance(text, str):
            text = text.strip()
            if len(text) > 4000 or any(ord(char) == 0 for char in text):
                text = text[:4000].replace("\x00", "")
        else:
            text = ""
        if kind in TEXT_KINDS:
            if not text:
                return None
            media_type = None
            media_source = None
        elif kind in MEDIA_KINDS:
            media_source = _value(message, kind)
            if media_source is None and kind in {"raven_media", "visual_media"}:
                media_source = _value(message, "visual_media")
            if media_source is None and kind == "voice_media":
                media_source = _value(message, "media")
            if media_source is None and kind in {"xma_clip", "xma_media_share"}:
                media_source = _value(message, "xma_share")
            media_type = _media_type(message, kind, media_source)
        else:
            return None
        from_me = _value(message, "is_sent_by_viewer") is True
        sender_value = _value(message, "user_id")
        if sender_value is None and from_me:
            sender_id = self.expected_user_id
        else:
            try:
                sender_id = _numeric_id(sender_value, "message sender")
            except WorkerError:
                return None
        if sender_id not in member_ids:
            return None
        if sender_id == self.expected_user_id:
            from_me = True
        result: dict[str, Any] = {
            "id": message_id,
            "senderId": sender_id,
            "text": text or None,
            "timestamp": _timestamp_ms(_value(message, "timestamp")),
            "fromMe": from_me,
            "mediaType": media_type,
        }
        if media_type is not None:
            url = _extract_url(media_source)
            if url:
                media: dict[str, str] = {"url": url}
                mimetype = _safe_string(_value(media_source, "mime_type"), 200)
                file_name = _safe_string(_value(media_source, "file_name"), 255)
                if mimetype:
                    media["mimetype"] = mimetype
                if file_name:
                    media["fileName"] = file_name
                result["media"] = media
        reply = _value(message, "reply")
        reply_id = _value(reply, "id")
        if isinstance(reply_id, str) and SAFE_MESSAGE_ID.fullmatch(reply_id):
            result["replyToMessageId"] = reply_id
        return result

    def _normalize_thread(self, raw: Any, *, requested_id: str | None = None, message_limit: int = 20, remember: bool = True) -> dict[str, Any]:
        thread_id = _numeric_id(_value(raw, "id"), "thread ID")
        if requested_id is not None and thread_id != requested_id:
            raise WorkerError("provider_error", "Instagram returned a different thread.")
        raw_users = _value(raw, "users")
        if not isinstance(raw_users, (list, tuple)) or len(raw_users) > 100:
            raise WorkerError("provider_error", "Instagram returned invalid thread members.")
        members: list[str] = []
        for user in raw_users:
            member_id = _numeric_id(_value(user, "pk"), "thread member")
            if member_id not in members:
                members.append(member_id)
        if self.expected_user_id not in members:
            members.append(self.expected_user_id)
        is_group = _value(raw, "is_group") is True
        if (not is_group and len(members) != 2) or (is_group and len(members) < 3):
            raise WorkerError("provider_error", "Instagram returned invalid thread membership.")
        raw_messages = _value(raw, "messages")
        if not isinstance(raw_messages, (list, tuple)):
            raise WorkerError("provider_error", "Instagram returned invalid thread messages.")
        member_set = set(members)
        messages = []
        seen = set()
        for raw_message in raw_messages[:message_limit]:
            message = self._normalize_message(raw_message, member_set, thread_id)
            if message is None or message["id"] in seen:
                continue
            seen.add(message["id"])
            messages.append(message)
        title = _safe_string(_value(raw, "thread_title"), 200, empty=True) or ""
        result = {"id": thread_id, "isGroup": is_group, "title": title, "memberIds": members, "messages": messages}
        if remember:
            self._remember(result)
        return result

    def poll(self, limit: int) -> dict[str, Any]:
        client = self._require_client(fresh=True)
        raw_threads = self._provider(client.direct_threads, amount=limit, thread_message_limit=20)
        if not isinstance(raw_threads, (list, tuple)) or len(raw_threads) > limit:
            raise WorkerError("provider_error", "Instagram returned an invalid thread list.")
        return {"account": dict(self.account), "threads": [self._normalize_thread(raw) for raw in raw_threads]}

    def thread(self, thread_id: str, limit: int) -> dict[str, Any]:
        client = self._require_client(fresh=True)
        raw = self._provider(client.direct_thread, int(thread_id), amount=limit)
        return self._normalize_thread(raw, requested_id=thread_id, message_limit=limit)

    def _fresh_source(self, client: Any, thread_id: str, source_message_id: str) -> dict[str, Any]:
        remembered = self.sources.get((thread_id, source_message_id))
        if remembered is None:
            raise WorkerError("invalid_request", "Source message must be read before replying.")
        raw = self._provider(client.direct_thread, int(thread_id), amount=50)
        thread = self._normalize_thread(raw, requested_id=thread_id, message_limit=50, remember=False)
        source = next((message for message in thread["messages"] if message["id"] == source_message_id), None)
        if source is None or self._source_fingerprint(source) != remembered or source["fromMe"] or source["senderId"] not in thread["memberIds"]:
            raise WorkerError("invalid_request", "Source message is no longer eligible for reply.")
        return source

    def send_text(self, thread_id: str, source_message_id: str, text: str) -> dict[str, Any]:
        client = self._require_client(fresh=True)
        self._fresh_source(client, thread_id, source_message_id)
        sent = self._provider(client.direct_send, text, thread_ids=[int(thread_id)])
        return self._sent_result(sent)

    def send_image(self, thread_id: str, source_message_id: str, data: bytes, mimetype: str) -> dict[str, Any]:
        client = self._require_client(fresh=True)
        self._fresh_source(client, thread_id, source_message_id)
        suffix = ".png" if mimetype == "image/png" else ".jpg"
        try:
            with redirect_stdout(DISCARD), redirect_stderr(DISCARD):
                from PIL import Image

                with Image.open(io.BytesIO(data)) as image:
                    width, height = image.size
                    expected_format = "PNG" if mimetype == "image/png" else "JPEG"
                    if image.format != expected_format or width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                        raise WorkerError("invalid_request", "Image is invalid.")
                    image.verify()
        except WorkerError:
            raise
        except Exception:
            raise WorkerError("invalid_request", "Image is invalid.") from None
        temporary = tempfile.mkdtemp(prefix=".instagram-upload-", dir=self.data_dir)
        os.chmod(temporary, 0o700)
        try:
            path = Path(temporary) / f"upload{suffix}"
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
            except Exception:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                raise
            sent = self._provider(client.direct_send_photo, path, thread_ids=[int(thread_id)])
            return self._sent_result(sent)
        finally:
            shutil.rmtree(temporary, ignore_errors=True)

    def _sent_result(self, sent: Any) -> dict[str, Any]:
        message_id = _value(sent, "id")
        if not isinstance(message_id, str) or not SAFE_MESSAGE_ID.fullmatch(message_id):
            raise WorkerError("provider_error", "Instagram returned an incomplete send result.")
        return {"messageId": message_id, "timestamp": _timestamp_ms(_value(sent, "timestamp"))}

    def handle(self, request: Any) -> dict[str, Any]:
        request_id = _response_id(request)
        try:
            operation, fields = _validate_request(request)
            if operation == "status":
                result = self.status()
            elif operation == "poll":
                result = self.poll(fields["limit"])
            elif operation == "thread":
                result = self.thread(fields["threadId"], fields["limit"])
            elif operation == "send_text":
                result = self.send_text(fields["threadId"], fields["sourceMessageId"], fields["text"])
            else:
                data = _decode_image(fields["data"])
                result = self.send_image(fields["threadId"], fields["sourceMessageId"], data, fields["mimetype"])
            return {"id": request_id, "ok": True, "result": result}
        except WorkerError as error:
            response: dict[str, Any] = {"id": request_id, "ok": False, "error": {"code": error.code, "message": error.public_message}}
            if error.retry_after is not None:
                response["error"]["retryAfter"] = error.retry_after
            return response
        except Exception:
            return {"id": request_id, "ok": False, "error": {"code": "provider_error", "message": "Instagram worker failed."}}


def _response_id(request: Any) -> str:
    if not isinstance(request, dict):
        return ""
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in request_id):
        return ""
    return request_id


def _validate_request(request: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(request, dict):
        raise WorkerError("invalid_request", "Request must be an object.")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in request_id):
        raise WorkerError("invalid_request", "Request ID is invalid.")
    operation = request.get("operation")
    schemas = {
        "status": set(),
        "poll": {"limit"},
        "thread": {"threadId", "limit"},
        "send_text": {"threadId", "sourceMessageId", "text"},
        "send_image": {"threadId", "sourceMessageId", "data", "mimetype"},
    }
    if operation not in schemas:
        raise WorkerError("invalid_request", "Operation is invalid.")
    expected = {"id", "operation"} | schemas[operation]
    if set(request) != expected:
        raise WorkerError("invalid_request", "Request fields are invalid.")
    fields = {key: request[key] for key in schemas[operation]}
    if "limit" in fields:
        maximum = 20 if operation == "poll" else 50
        if not isinstance(fields["limit"], int) or isinstance(fields["limit"], bool) or not 1 <= fields["limit"] <= maximum:
            raise WorkerError("invalid_request", "Limit is invalid.")
    if "threadId" in fields:
        fields["threadId"] = _request_numeric_id(fields["threadId"], "Thread ID")
    if "sourceMessageId" in fields:
        source = fields["sourceMessageId"]
        if not isinstance(source, str) or not SAFE_MESSAGE_ID.fullmatch(source):
            raise WorkerError("invalid_request", "Source message ID is invalid.")
    if operation == "send_text":
        text = fields["text"]
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\x00" in text:
            raise WorkerError("invalid_request", "Message text is invalid.")
        fields["text"] = text
    if operation == "send_image":
        if fields["mimetype"] not in {"image/png", "image/jpeg"} or not isinstance(fields["data"], str):
            raise WorkerError("invalid_request", "Image is invalid.")
        if len(fields["data"]) > ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 4:
            raise WorkerError("invalid_request", "Image is too large.")
    return operation, fields


def _decode_image(value: str) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise WorkerError("invalid_request", "Image is invalid.") from None
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise WorkerError("invalid_request", "Image is too large.")
    return data


def _encoded_response(response: dict[str, Any]) -> bytes:
    try:
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        encoded = b'{"id":"","ok":false,"error":{"code":"provider_error","message":"Instagram worker failed."}}'
    if len(encoded) > MAX_LINE_BYTES:
        request_id = response.get("id") if isinstance(response.get("id"), str) else ""
        encoded = json.dumps({"id": request_id, "ok": False, "error": {"code": "provider_error", "message": "Instagram response exceeded its limit."}}, separators=(",", ":")).encode()
    return encoded + b"\n"


def _read_line(stream: Any) -> tuple[bytes, bool] | None:
    line = stream.readline(MAX_LINE_BYTES + 2)
    if not line:
        return None
    oversized = len(line) > MAX_LINE_BYTES or not line.endswith(b"\n")
    if oversized and not line.endswith(b"\n"):
        while True:
            remainder = stream.readline(MAX_LINE_BYTES + 2)
            if not remainder or remainder.endswith(b"\n"):
                break
    return line, oversized


def main() -> int:
    worker = InstagramWorker.from_environment()
    while True:
        item = _read_line(sys.stdin.buffer)
        if item is None:
            return 0
        line, oversized = item
        if oversized:
            response = {"id": "", "ok": False, "error": {"code": "invalid_request", "message": "Request exceeded its limit."}}
        else:
            try:
                request = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
                request = None
            response = worker.handle(request)
        sys.stdout.buffer.write(_encoded_response(response))
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        exit_code = main()
    except (BrokenPipeError, KeyboardInterrupt, OSError):
        exit_code = 0
    except Exception:
        exit_code = 1
    raise SystemExit(exit_code)
