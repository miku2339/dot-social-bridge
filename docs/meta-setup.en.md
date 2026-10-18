# Instagram / Facebook setup

[English](meta-setup.en.md) | [繁體中文](meta-setup.md) | [日本語](meta-setup.ja.md)

Instagram professional DMs and Facebook Page Messenger share the `/admin` communications console. The code includes OAuth, webhooks, text/image replies, permissions, and MCP Events. Local mocked tests pass; real account authorization and message delivery still require acceptance testing.

This page covers only the official Meta interfaces. Personal Instagram DMs and groups have a separate, optional, unofficial [`instagrapi` setup](instagram-private.en.md) with its own session and private numeric IDs; it does not require a Meta App. The two paths may coexist, but official IGSIDs and private-connection IDs are not interchangeable.

## Requirements

- An always-on, connected computer, VPS, or NAS running the bridge without sleeping.
- A publicly reachable HTTPS `PUBLIC_URL` and an existing admin login.
- An Instagram Business/Creator account or a Facebook Page you manage. Personal Messenger and Facebook group chats are outside this integration.
- Your own Meta Developer App. Start with testers holding the required app/account roles; serving other accounts requires the applicable App Review and Advanced Access.

## Connect an account

1. Configure Instagram API with Instagram Login or Messenger Platform in Meta. Instagram requests `instagram_business_basic` and `instagram_business_manage_messages`; Facebook requests `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, and `pages_read_engagement`.
2. Open `/admin` and choose the platform's application settings. Enter the App ID, App Secret, and a webhook verification token. Enter secrets only in the protected console; keep them out of Git, chat, and URLs.
3. Register the displayed OAuth callback as a valid redirect URI. Register the displayed webhook URL and matching verification token with the relevant Meta product and subscribe to `messages`. Copy the exact URLs from the console.
4. Save, then start authorization. The account holder completes Meta's consent flow. For Facebook, select the actual Page to connect in the console.
5. Verify the account ID. Automatic replies start disabled; enable them when ready. Connection, restart, and resume only process messages after the new activation time and do not backfill older messages.
6. Rescan and authorize the ChatGPT plugin, explicitly granting the required platform read/send scopes and subscribing to its event. Existing WhatsApp grants do not gain Meta permissions automatically.

Callback and webhook paths are `/admin/meta/callback/{instagram|facebook}` and `/webhooks/meta/{instagram|facebook}`. Ordinary console responses and events do not expose App Secrets, platform tokens, or original media URLs.

## Tools and replies

Each platform has seven tools: `status`, `list_chats`, `get_messages`, `get_pending_replies`, `get_media`, `send_text`, and `send_image`, prefixed with `instagram_` or `facebook_`. Events are `instagram.message_received` and `facebook.message_received`.

Sending requires a received `sourceMessageId` in the same chat and an `idempotencyKey`. Immediately before sending, the bridge checks the account, reply switch, activation time, and ordinary 24-hour window. It does not use `HUMAN_AGENT` to extend automated AI replies. Images must be PNG/JPEG, up to 5 MiB. Source binding is an authorization check and does not promise a quoted reply bubble in Meta's interface.

Inbound webhooks are signed with the App Secret and deduplicated. Signed MCP Events then wake native Dot without a Work polling schedule. Auto-review and the applicable usage limits remain in effect.

## Identity and maintenance

- Identity uses platform + connected account ID + sender ID. Display names and handles grant no permissions; new senders default to L5. An official Instagram IGSID is not an `instagrapi` private ID.
- After a sender has messaged the account, edit L2–L5 or explicitly bind the observed sender to an existing verified owner for L1. An old Instagram handle note is not a verified binding.
- Platform, account, and chat storage are separate. Switching or disconnecting excludes old account messages from current read access. This does not verify hard isolation of native Dot memory or tools.
- Replies stop when credentials expire or become invalid; reauthorize in the console. Permanent validity is not guaranteed. `meta-state.json` contains credentials: retain mode 0600 and exclude it from public backups.

Acceptance sequence: authorization → real inbound message → same-chat text/image reply → restart/deduplication → pause/revocation. Mock tests do not establish Meta approval or real delivery.

[Instagram documentation](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api) · [Messenger documentation](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages) · [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
