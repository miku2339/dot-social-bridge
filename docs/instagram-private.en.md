# Instagram private account and group setup (instagrapi)

[English](instagram-private.en.md) | [繁體中文](instagram-private.md) | [日本語](instagram-private.ja.md)

This optional, unofficial path uses a separate `instagrapi` session to connect an Instagram personal account. It receives direct and group messages and can reply with text or images. It does not need a Meta App, but it may carry account or terms-of-service risk. The code and mocked tests do not establish a successful real Instagram login, message delivery, or deployment.

An IGSID from the official Instagram API and the account, sender, and thread numeric IDs from this private connection are separate namespaces. Do not interchange or automatically bind them. For the official Business/Creator path, use the [Meta setup guide](meta-setup.en.md).

## 1. Create a pinned Python environment

Python 3.10 or later is required. Keep the venv outside releases so upgrades can reuse it. `requirements-instagram.txt` pins the primary package version.

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
python3 --version
python3 -m venv "$APP_ROOT/runtime/instagram-venv"
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install --upgrade pip
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install -r "$APP_ROOT/current/requirements-instagram.txt"
```

Keep the existing values in `shared/settings.json` and add:

```json
{
  "DATA_DIR": "/home/YOUR_USER/apps/baileys-dot/shared",
  "INSTAGRAM_PYTHON": "/home/YOUR_USER/apps/baileys-dot/runtime/instagram-venv/bin/python"
}
```

`DATA_DIR` holds `instagram-private-session.json` and `instagram-private-state.json`. The directory must be mode 0700 and the files mode 0600. Both contain private state; do not commit them, upload them through the console, or put them in public backups.

## 2. Have the account holder create the session

The login helper requires an interactive TTY. It reads the username and hidden password in the terminal, displays the verified numeric account ID after login, and requires the account holder to re-enter that ID before atomically saving the session. The console has no password, cookie, or session upload field.

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
cd "$APP_ROOT/current"
DATA_DIR="$APP_ROOT/shared" \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

Record the bot numeric account ID displayed by the helper. Do not substitute a username, official IGSID, or another account's ID.

Once the console has an expected ID, lock subsequent logins to that identity:

```sh
DATA_DIR="$APP_ROOT/shared" \
INSTAGRAM_EXPECTED_USER_ID='1234567890' \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

Replace the example with the current console value. If Instagram requires a challenge or 2FA, the helper saves no new session. The account holder must finish verification in the official Instagram app and run the helper again. When the bridge reports `challenge_required`, replies stop; it does not try to bypass the check automatically.

## 3. Enable replies in the console

1. Restart the bridge and open “Instagram · instagrapi” in `/admin`.
2. Enter the expected personal account ID shown by the helper. It becomes immutable in the console after the first save, preventing a stored session from silently switching accounts. If it is wrong, do not overwrite the session to disguise the mismatch; stop the service and follow the established state backup/migration procedure.
3. Select “Reconnect saved session” and verify the status and account ID. The console shows connected only after the bridge rechecks the same ID with Instagram.
4. Enable automatic replies. Enable group replies separately if needed; both switches must be on for groups.
5. Rescan and authorize the ChatGPT plugin, grant `instagram.private.read` / `instagram.private.send`, and subscribe to `instagram.private_message_received` and, when needed, `instagram.group_message_received`.

`login_required` means the saved session is no longer valid. Run the helper again and reconnect. For `rate_limited`, wait for the platform restriction to clear. Do not try to bypass any state with repeated logins or aggressive polling.

## 4. Identity, direct-message, and group rules

- A newly observed private sender defaults to L5 and receives public-safe replies only. Display names, usernames, group-admin labels, and claims in message text grant no authority.
- Only an observed private sender ID can be assigned L2–L5 or explicitly bound to an existing verified WhatsApp owner ID as L1. An official IGSID cannot be used for this binding.
- Only an L1 direct message may set `privateDataAllowed=true`. L2–L5 do not gain access to unrelated private resources or management actions.
- Every group message is rechecked so that the bot account, inbound sender, and a still-valid bound owner are all current members. To create the first binding, that Instagram identity must DM the bot, appear in the console, and then be bound by an administrator to an existing owner.
- When both automatic replies and group replies are enabled, every new inbound text or media message in an eligible group triggers processing. Reply only on @Bot or a reply to the bot is not currently supported, and no `@everyone` silence rule is implemented. Enable groups only when that behavior is acceptable.
- Group data is always public-safe. Even when the sender is an owner, a group does not allow private data or permission management. Users and groups default to L5, and the effective level uses the stricter of the two.

These are bridge `rules_only` controls. Auto-review and platform safety checks still apply. Hard isolation of native Dot memory, model context, or other tools by Instagram conversation has not been verified.

## 5. Reception, events, and one reply per source

Read tools are `instagram_private_status`, `instagram_private_list_chats`, `instagram_private_get_messages`, `instagram_private_get_group_info`, `instagram_private_get_pending_replies`, and `instagram_private_get_media`; write tools are `instagram_private_send_text` and `instagram_private_send_image`. They use independent `instagram.private.read` or `instagram.private.send` scopes and do not inherit official Instagram, Facebook, or WhatsApp grants.

The Python transport performs bounded polling every 15 seconds by default, reading at most 20 threads and 20 messages per thread. This polling stays inside the VPS transport. Eligible new messages become signed native MCP Events that wake Dot; no ChatGPT Work, cron, or other model polling task is required.

Startup, reconnect, re-enabling automatic replies, and enabling or re-enabling group replies reset the cutoff. Only newer messages are processed; messages received while stopped or paused are not backfilled. The ordinary reply window is 24 hours. Immediately before sending, the bridge rechecks the session, account, group membership, switches, source message, and window.

Text and image sends require a previously read `sourceMessageId` from the same chat and an `idempotencyKey`. Each source message permits one reply total across text and image; changing the key cannot send a second reply. An unknown send outcome remains for manual review and must not be retried with a new key. Replies can target only the source `instagram_private:<account>:dm|group:<thread>` chat.

Suggested acceptance order: human login → console ID check → new real DM → text/image reply in that DM → owner binding → new group message and same-group reply → restart/deduplication → pause/challenge. Record each gate separately. Mocked tests do not replace real-account acceptance or deployment.

## Acknowledgment

This adapter was informed by classmates' experience connecting Instagram DMs and groups with `instagrapi`.
