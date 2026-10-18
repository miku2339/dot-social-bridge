# Native Dot Multi-Platform Integration Research

[English](social-platforms.en.md) | [繁體中文](social-platforms.md) | [日本語](social-platforms.ja.md)

Verified on 2026-10-18. Instagram professional DMs, Facebook Page Messenger, and the optional `instagrapi` personal-account DM/group path have local implementations with mocked tests. Real Meta OAuth, Instagram sessions, and message delivery remain unaccepted, and the work is not deployed. The remaining platforms are still public-API research and planned work; they must not be treated as connected.

## Hosting requirements

You need a **computer, VPS, or NAS** that stays powered on, connected to the internet, and running the bridge service. A NAS must support this project's runtime requirements. Disable host sleep while automatic messaging is needed. Automatic message reception and replies stop while the host is shut down, asleep, offline, or the bridge service is stopped.

## Feasibility

| Platform | Recommended entry point | Supported scope | Main prerequisites and limitations |
| --- | --- | --- | --- |
| Instagram | Official Instagram API with Instagram Login | Professional-account DMs, with text and multiple media types | Business or Creator account; the other person must contact the account first; generally a 24-hour reply window; serving third-party accounts requires the applicable review |
| Instagram private connection | Unofficial `instagrapi` session | Personal-account DMs and groups with an owner present; text/image replies | Human TTY login; account/terms risk; IDs differ from official IGSIDs; real delivery is unaccepted |
| Facebook | Official Messenger Platform | Facebook Page Messenger DMs and media | Page token, messaging permissions, and the applicable review; does not include personal Messenger or private group chats; generally a 24-hour window |
| Threads | Official Threads API | Public posts, replies, mentions, and media publishing | No public official DM interface was found; do not promise a private-message bot |
| Weixin iLink / ClawBot | The underlying iLink protocol used by Tencent's Weixin channel | Direct chats with ClawBot | Does not expose the entire personal Weixin inbox; the current channel declares only `direct`; formal support for an independent adapter remains unconfirmed |
| Weixin Wechaty | Community SDK plus a selected Puppet | Direct messages, group chats, and media, depending on the Puppet | Not an official Tencent personal Weixin API; sign-in, reliability, IDs, and paid tokens depend on the provider |
| QQ | Official QQ Bot | C2C, QQ group @ mentions, and QQ channels | Separate bot identity; real-name verification, sandbox testing, review, and a fixed public-IP allowlist for production |
| Moltbook | Official REST API | Feed, posts, comments, and replies | A custom bridge polls and emits events; private-message documentation is currently incomplete, so DM support is not promised |

## Instagram, Facebook, and Threads

The Instagram Login path does not require a linked Facebook Page, but it does require an Instagram Business or Creator account. The core permissions are `instagram_business_basic` and `instagram_business_manage_messages`. Receive messages through Webhooks and send through `/{IG_ID}/messages`. Standard Access applies to eligible accounts that the app user owns or manages; serving other accounts requires confirmation of Advanced Access and App Review. The Conversations API can fill gaps, but it returns full details for only the 20 most recent messages in each conversation and is unsuitable as the sole inbound-message source. [Instagram Messaging](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api), [Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api)

For personal accounts and groups, the project also has an optional [Instagram `instagrapi` path](instagram-private.en.md). A bounded poller reads a separate session inside the VPS and converts eligible new messages into signed native MCP Events. It uses neither a Meta App nor a ChatGPT Work polling task. Personal account, sender, and thread IDs are separate from official IGSIDs. New identities default to public-safe L5, and a group also requires both the bot and an explicitly bound owner to be currently present. This is an unofficial path; real login and delivery remain unaccepted.

The first Facebook version should be limited to Facebook Page Messenger. It uses a Page token, `pages_messaging`, and the required asset role; inbox reads must also confirm `pages_manage_metadata` and `pages_read_engagement`. Recipients are addressed by Page-scoped ID (PSID), and the reply window must be checked again immediately before sending. This research found no official integration for a personal Messenger inbox or private group chats. The Facebook Groups API was removed on 2024-04-22. [Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages), [Groups API removal](https://developers.facebook.com/docs/graph-api/changelog/version19.0)

Threads uses permissions including `threads_basic`, `threads_content_publish`, `threads_read_replies`, and `threads_manage_replies`. Publishing creates and then publishes a container; replies specify `reply_to_id`. The app can subscribe to Webhook fields such as `replies` and `mentions`. Production Webhooks have additional requirements including Live mode, Advanced Access, and business verification. Public media must be available at a URL that the platform can read; use short-lived, isolated media URLs. This is a public-interaction entry point, not verified Threads DM support. [Threads Posts](https://developers.facebook.com/documentation/threads/posts), [Webhooks](https://developers.facebook.com/documentation/threads/webhooks)

Meta's normal reply windows do not grant an AI an ongoing right to initiate private messages. `HUMAN_AGENT` is for handling by a real person and must not be used to extend an automated AI reply window. Special ad entry points and other exceptions require case-by-case live testing and must not be enabled by default. [Human Agent](https://developers.facebook.com/docs/features-reference/human-agent)

## Weixin: Prioritize iLink and Evaluate Wechaty Separately

The verifiable official component is Tencent-maintained `@tencent-weixin/openclaw-weixin`. Its current capability declaration contains only `direct`; this does not establish support for ordinary Weixin groups or access to the full personal Weixin history. Sign-in requires scanning a QR code and confirming on the phone, and may also require a verification code. [Tencent README](https://github.com/Tencent/openclaw-weixin), [OpenClaw WeChat documentation](https://docs.openclaw.ai/channels/wechat)

iLink receives messages through `getUpdates` long polling and retains the inbound `context_token` for replies. The public protocol and client source can inform an independent Node transport prototype while retaining Dot as the reasoning endpoint. However, the document targets compatible backend implementation/integration; it does not establish Tencent's formal support or terms-of-service authorization for a standalone Dot client. The official npm package depends on the OpenClaw runtime and cannot be treated as a general-purpose SDK. Eligibility for an independent implementation, regional availability, pricing, and proactive sending remain unconfirmed. Inbound media includes images, voice, documents, and video. Outbound acceptance should first cover text, images, video, and documents; voice requires separate acceptance testing. [iLink protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md), [Group-chat request](https://github.com/Tencent/openclaw-weixin/issues/42)

Wechaty's Room, Message, and FileBox APIs are only SDK abstractions; actual capability depends on the Puppet. The Web Puppet documentation lists sign-in restrictions, and contact and room IDs may change across sessions, so an old owner binding must not be reused automatically. Puppet Service may require a provider token, and its price and availability cannot be inferred from the SDK license. Account-restriction risk also remains. [Wechaty Room](https://wechaty.js.org/docs/api/room), [Web Puppet limitations](https://wechaty.js.org/docs/puppet-providers/wechat), [Tokens](https://wechaty.js.org/docs/puppet-services/tokens)

If all participants and groups can move into WeCom, an official option is a WeCom intelligent bot. It supports direct chats and group @ mentions, with either an encrypted callback or WebSocket transport. It is an entry point inside a WeCom organization and must not be presented as access to ordinary personal Weixin groups or external customer groups. [WeCom API](https://developer.work.weixin.qq.com/document/path/101039), [WebSocket](https://developer.work.weixin.qq.com/document/path/101463)

## QQ: Start with C2C and Group @ Mentions

QQ Bot is a separate bot identity and does not take over a personal QQ inbox. Current documentation offers both Webhook and WebSocket transports and uses the unified API host `api.bot.qq.com`. Do not copy older guidance that uses `api.sgroup.qq.com` or claims that all WebSocket support has ended. Phase one can use signature-verified Webhooks for C2C and group @ events. If channel replies are added, separately verify the official requirement for an online WS connection. [Current platform](https://bot.q.qq.com/wiki/), [Event transport](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html), [Official Node SDK](https://github.com/tencent-connect/qqbot-nodejs)

Passive replies require the original `msg_id`, a reply sequence number, and a valid window. The official C2C page currently contains both 60-minute and 5-minute descriptions. Use a conservative 5-minute deadline and verify it in the sandbox; apply the same window check to group replies. Eligibility for full group events through `GROUP_MESSAGE_CREATE` still requires platform confirmation; a normal @ subscription must not be presented as approval to read every group message. Uploaded-media `file_info` expires and is context-specific, so it must not be reused between direct and group chats. [C2C sending](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html), [Full group events](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html), [Media](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)

Production also requires review and a fixed public-IP allowlist. The existing VPS must be verified in the sandbox before it is treated as eligible. Domains in message URLs have separate allowlist and ICP filing requirements. Until these conditions are verified, validate text only and do not assume a host migration or change to the existing WhatsApp deployment.

## Moltbook: Start with Public Posts and Comments

Use `https://www.moltbook.com/api/v1`, an agent API key, and the claim flow. The first version can provide feed reads, reads of selected posts and comments, posting, and replies. The bridge polls `/home` and selected post comments, deduplicates by ID, and sends only new subscribed content to Dot. Reads, posts, and comments have separate rate limits; on `429`, follow the service's retry guidance. Content may remain in verification pending, so successful creation does not prove that it has become public. [Moltbook API](https://www.moltbook.com/skill.md)

The official `messaging.md` returned 404 during this research, while `heartbeat.md` still mentioned DM, so private messaging remains unverified. No official event Webhook specification suitable for direct use was found, so the bridge should poll initially; do not create a repeating ChatGPT Work polling task. A Moltbook agent identity token proves only the agent identity, not that the human behind it is this bridge's L1 owner. [Official heartbeat](https://www.moltbook.com/heartbeat.md), [Identity](https://www.moltbook.com/developers)

## Shared Bridge Layer

The shared adapter architecture below is implemented locally for official Instagram, Facebook, and the optional private `instagrapi` path. Applying it to the remaining platforms is still planned work:

```text
Platform Webhook / WebSocket / long polling / REST polling
  → per-platform adapter: verify signatures, deduplicate, retain required reply credentials
  → normalized event: platform + account + conversation + sender + message ID
  → identity binding, L1–L5, group rules, reply windows, pause, and effective time
  → native MCP Events → Dot → Auto-review
  → same-platform / same-conversation reply tool → platform API
```

OpenAI's current MCP Events supports Dot. The integration direction is for the bridge to send signed Webhooks to ChatGPT. Polling on the upstream platform does not prevent this design: VPS code can perform polling and filtering without creating a Work polling task. After adding events, the plugin must still be rescanned, followed by subscription setup and real-delivery acceptance testing. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

- **Identity:** Create a stable internal person ID in the bridge. Store platform aliases as `platform + app/bot scope + account + identity type + subject ID`. Keep IG IGSIDs, `instagrapi` private numeric IDs, Facebook PSIDs, and QQ C2C and group-member OpenIDs in separate namespaces. For iLink, use `ilink_bot_id` as the account scope and inbound `from_user_id` as the sender. Store the QR response's `ilink_user_id` separately as the scanning authorizer; it must not automatically become the sender or owner. IDs may change after rebinding; do not promise that platform IDs are permanent.
- **Binding:** A nickname, handle, matching phone number, or group-admin marker must not automatically grant L1. Every new platform identity must be bound by the verified owner. The current Instagram-name note in the console is not verification.
- **Permissions:** Keep read/write OAuth scopes, tokens, roles, and switches separate by platform. The existing WhatsApp token must not gain access to a new platform automatically. Public posts and private messages require different actions and rules.
- **Conversation data:** Store messages, summaries, and deduplication records under `platform + bot account + conversation type + conversation ID`. This isolates data in the bridge only; it does not prove that native Dot memory or tools are hard-isolated by conversation. Until that is verified, groups and other people must not be allowed to read the owner's private data.
- **Sending:** Preserve the source message and same-conversation destination. Keep platform reply credentials only on the server and include only an opaque reference in the event. Immediately before sending, recheck the role, reply window, pause state, and cutoff. Preserve Auto-review, quoting, and idempotency. Resuming must not backfill old messages, and an expired reply must not be silently converted into a new proactive DM.
- **Console:** Show each platform's real connection state, actual capabilities (direct chat, group chat, or posting), review state, and errors. Platforms that are not connected must remain marked as not connected. Adding more platforms does not authorize autonomous public posting.

An idle bridge does not require model judgment, but that does not mean every event-triggered Dot run always has zero usage. Official documentation distinguishes ordinary Dot conversations from the Work or Codex tasks that they initiate; this research did not find explicit authority to exclude every native MCP event task from usage. VPS, platform, and Puppet-provider costs are also separate. [Dot usage](https://learn.chatgpt.com/docs/dots#access)

## Recommended Rollout Order

1. **Shared capability and identity model:** Keep the existing WhatsApp path. Instagram and Facebook namespaces and capability declarations are implemented locally and await pre-deployment acceptance.
2. **Instagram and Facebook Page:** Complete real-account OAuth, DM delivery, restart, and revocation acceptance with accounts managed by the owner.
3. **Optional `instagrapi`:** Use a dedicated test account first and accept human login, ID verification, DMs, owner binding, groups, restart, and challenge stopping before considering a primary account.
4. **QQ C2C and group @ mentions:** Use the official bot sandbox and accept the reply window, signatures, media, and revocation behavior.
5. **Weixin iLink:** Run a direct-chat experiment after confirming eligibility and availability for an independent adapter. Use WeCom for groups only if they can move into WeCom; otherwise evaluate Wechaty separately.
6. **Threads and Moltbook:** Add public post/comment tools and events, define separate public-publishing rules, and do not enable autonomous roaming posts initially.

Accept each platform incrementally through: authorization succeeds → real inbound message → same-conversation reply → quote/media → restart/deduplication → pause/revocation. Documentation feasibility, sandbox success, and production launch are separate states.
