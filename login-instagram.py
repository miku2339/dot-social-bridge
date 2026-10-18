#!/usr/bin/env python3
"""Create the private Instagram session used by instagram-worker.py."""

from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import getpass
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


SESSION_NAME = "instagram-private-session.json"
MAX_SESSION_BYTES = 2 * 1024 * 1024
NUMERIC_ID = re.compile(r"^[1-9][0-9]{0,63}$")


class _DiscardText(io.TextIOBase):
    def write(self, value: str) -> int:
        return len(value)


DISCARD = _DiscardText()


def _value(source, name, default=None):
    if isinstance(source, dict):
        return source.get(name, default)
    return getattr(source, name, default)


def _data_dir(value: str | None) -> Path:
    source = value or os.environ.get("DATA_DIR") or str(Path(__file__).resolve().parent / "shared")
    directory = Path(source).expanduser()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = directory.resolve(strict=True)
    if not directory.is_dir():
        raise RuntimeError("Instagram data directory is invalid.")
    os.chmod(directory, 0o700)
    return directory


def _write_session(client, directory: Path) -> Path:
    target = directory / SESSION_NAME
    try:
        if stat.S_ISLNK(target.lstat().st_mode):
            raise RuntimeError("Existing Instagram session path is unsafe.")
    except FileNotFoundError:
        pass
    descriptor, temporary_name = tempfile.mkstemp(prefix=".instagram-session-", suffix=".json", dir=directory)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        with redirect_stdout(DISCARD), redirect_stderr(DISCARD):
            client.dump_settings(temporary)
        file_stat = temporary.lstat()
        if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode) or not 2 <= file_stat.st_size <= MAX_SESSION_BYTES:
            raise RuntimeError("Instagram session was not saved safely.")
        with temporary.open("r", encoding="utf-8") as handle:
            if not isinstance(json.load(handle), dict):
                raise RuntimeError("Instagram session was not saved safely.")
        os.chmod(temporary, 0o600)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
        return target
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Connect the optional private Instagram bridge.")
    parser.add_argument("--data-dir")
    parser.add_argument("--username")
    args = parser.parse_args(argv)
    if not sys.stdin.isatty():
        print("Interactive terminal input is required.", file=sys.stderr)
        return 2
    username = (args.username or input("Instagram username: ")).strip()
    if not username or len(username) > 100 or any(ord(char) < 33 or ord(char) == 127 for char in username):
        print("Instagram username is invalid.", file=sys.stderr)
        return 2
    password = getpass.getpass("Instagram password: ")
    if not password:
        print("Instagram password is required.", file=sys.stderr)
        return 2
    try:
        directory = _data_dir(args.data_dir)
        with redirect_stdout(DISCARD), redirect_stderr(DISCARD):
            from instagrapi import Client

            client = Client()
            client.login(username, password)
            account = client.account_info()
        account_id = str(_value(account, "pk", ""))
        actual_username = str(_value(account, "username", username))
        if not NUMERIC_ID.fullmatch(account_id) or str(getattr(client, "user_id", account_id)) != account_id:
            raise RuntimeError("Instagram account identity could not be verified.")
        expected_id = os.environ.get("INSTAGRAM_EXPECTED_USER_ID")
        if expected_id is not None and (not NUMERIC_ID.fullmatch(expected_id) or expected_id != account_id):
            raise RuntimeError("Instagram account identity did not match the configured account.")
        print(f"Connected account: @{actual_username} (ID {account_id})")
        confirmation = input("Re-enter the account ID to save this session: ").strip()
        if confirmation != account_id:
            print("Account confirmation did not match; session was not saved.", file=sys.stderr)
            return 2
        _write_session(client, directory)
        print(f"Instagram session saved for account ID {account_id}.")
        return 0
    except Exception as error:
        names = {base.__name__ for base in type(error).__mro__}
        if names & {"ChallengeError", "ChallengeRequired", "ChallengeRedirection", "ChallengeSelfieCaptcha", "ChallengeUnknownStep", "TwoFactorRequired"}:
            message = "Instagram requires manual verification in the official app; no session was saved."
        elif names & {"BadPassword", "BadCredentials", "LoginRequired", "ClientLoginRequired"}:
            message = "Instagram login was rejected; no session was saved."
        else:
            message = "Instagram connection failed; no session was saved."
        print(message, file=sys.stderr)
        return 1
    finally:
        password = ""


if __name__ == "__main__":
    try:
        exit_code = main()
    except (BrokenPipeError, KeyboardInterrupt, OSError):
        exit_code = 1
    except Exception:
        print("Instagram connection failed; no session was saved.", file=sys.stderr)
        exit_code = 1
    raise SystemExit(exit_code)
