import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuthManager } from "./auth.mjs";
import { createApp } from "./server.mjs";

const ADMIN_TOKEN = "meta-console-test-password";
const ORIGIN = "http://localhost:4495";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = "http://localhost/callback";
const WEBHOOK_SECRET = "test-meta-webhook-secret";

function whatsappBridge() {
  return {
    ownerIdentities: { ownerIds: new Set(["owner@s.whatsapp.net"]) },
    getQr: () => null,
    getConsoleState: () => ({
      revision: "wa-revision",
      channels: { whatsapp: { status: "connected", autoReplyEnabled: true } },
      permissions: { valid: true, mode: "rules_only", defaultLevel: "L5" },
      users: [],
      groups: [],
    }),
    updateConsoleSettings: async () => {},
  };
}

function metaBridge() {
  const calls = [];
  const bridge = {
    calls,
    revision: 7,
    getConsoleState() {
      return {
        channels: {
          instagram: { status: "connected", account: { id: "101", name: "IG" }, autoReplyEnabled: false },
          facebook: { status: "ready_to_authorize", account: null, autoReplyEnabled: false },
        },
        metaRevision: bridge.revision,
        metaConfig: {
          instagram: { appId: "1001", hasAppSecret: true, hasVerifyToken: true },
          facebook: { appId: "2002", hasAppSecret: true, hasVerifyToken: true },
        },
        metaUsers: [{ platform: "instagram", accountId: "101", senderId: "301", displayName: "User", level: "L5" }],
        metaConversations: [{
          platform: "instagram", accountId: "101", chatId: "instagram:101:301", senderId: "301",
          displayName: "User", lastMessage: "private message body", lastTimestamp: 1_700_000_000_000, messageCount: 1,
        }],
      };
    },
    getStatus(platform) {
      calls.push(["status", platform]);
      return { platform, status: "connected" };
    },
    listChats: () => [],
    async beginAuthorization(platform, sessionHash) {
      calls.push(["begin", platform, sessionHash]);
      return { authorizationUrl: `https://www.${platform}.com/oauth/authorize` };
    },
    async completeAuthorization(platform, params) {
      calls.push(["complete", platform, params]);
    },
    async updateConsoleSettings(change) {
      calls.push(["update", change]);
      bridge.revision += 1;
    },
    verifyWebhook(platform, searchParams) {
      calls.push(["verify", platform, searchParams.get("hub.verify_token")]);
      if (searchParams.get("hub.verify_token") !== "verify-token") throw Object.assign(new Error("private verification detail"), { status: 403 });
      return searchParams.get("hub.challenge");
    },
    async ingestWebhook(platform, raw, signature) {
      const expected = Buffer.from(`sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`);
      const supplied = Buffer.from(String(signature));
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        throw Object.assign(new Error("private signature detail"), { status: 403 });
      }
      calls.push(["webhook", platform, Buffer.from(raw)]);
      return { stored: 1, emitted: 0 };
    },
  };
  return bridge;
}

function eventRouter() {
  const calls = [];
  return {
    calls,
    list(params, principal) {
      calls.push(["list", params, principal]);
      return { events: principal.scopes.filter((scope) => scope.endsWith(".read")).map((scope) => ({ name: `${scope.slice(0, -5)}.message_received` })) };
    },
    subscribe(params, principal) {
      calls.push(["subscribe", params, principal]);
      return { id: "subscription-1" };
    },
    unsubscribe(params, principal) {
      calls.push(["unsubscribe", params, principal]);
      return {};
    },
  };
}

async function fixture(t, { privateInstagram = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "dot-meta-server-"));
  const bridge = whatsappBridge();
  const meta = metaBridge();
  const events = eventRouter();
  const privateCalls = [];
  const instagramPrivateBridge = privateInstagram ? {
    getConsoleState: () => ({ channel: { status: "not_configured", account: null }, revision: 1, settings: { expectedAccountId: null }, users: [], groups: [] }),
    getStatus: async () => ({ status: "not_configured", account: null }),
    updateConsoleSettings: async (change) => { privateCalls.push(change); },
  } : null;
  const server = await createApp({
    bridge,
    metaBridge: meta,
    instagramPrivateBridge,
    events,
    config: { dataDir, publicUrl: ORIGIN, adminToken: ADMIN_TOKEN, allowInsecureHttp: true, allowLocalRedirects: true },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, bridge, meta, events, privateCalls };
}

async function token(base, scopes) {
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = "m".repeat(64);
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    state: "meta-test",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
  const approval = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, admin_token: ADMIN_TOKEN }),
  });
  const code = new URL(approval.headers.get("location")).searchParams.get("code");
  const exchange = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  assert.equal(exchange.status, 200);
  return (await exchange.json()).access_token;
}

async function rpc(base, accessToken, method, params) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function admin(base) {
  const login = await fetch(`${base}/admin/login`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ admin_token: ADMIN_TOKEN }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const get = (path) => fetch(`${base}${path}`, { headers: { cookie } });
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { cookie, get, post };
}

test("Meta bridge enables only the four additional OAuth scopes and exposes 14 scoped tools", async (t) => {
  const { base, meta } = await fixture(t);
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(metadata.scopes_supported, [
    "whatsapp.read", "whatsapp.send", "events",
    "instagram.read", "instagram.send", "facebook.read", "facebook.send",
  ]);

  const instagramRead = await token(base, "instagram.read");
  const listed = await rpc(base, instagramRead, "tools/list", {});
  assert.equal(listed.status, 200);
  const tools = (await listed.json()).result.tools;
  assert.equal(tools.filter((tool) => tool.name.startsWith("instagram_") || tool.name.startsWith("facebook_")).length, 14);

  const status = await rpc(base, instagramRead, "tools/call", { name: "instagram_status", arguments: {} });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).result.structuredContent.platform, "instagram");
  assert.deepEqual(meta.calls.at(-1), ["status", "instagram"]);

  const denied = await rpc(base, instagramRead, "tools/call", {
    name: "facebook_send_text",
    arguments: { chatId: "facebook:202:302", sourceMessageId: "source-1", text: "hello", idempotencyKey: "abcdefgh" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="facebook\.send"/);
});

test("auth manager rejects additional scopes outside the fixed Meta whitelist", async () => {
  await assert.rejects(createAuthManager({
    publicUrl: ORIGIN,
    adminToken: ADMIN_TOKEN,
    allowInsecureHttp: true,
    additionalScopes: ["instagram.read", "arbitrary.admin"],
  }), /additionalScopes/);
});

test("Meta event routes authenticate the exact platform read scope", async (t) => {
  const { base, events } = await fixture(t);
  const instagramRead = await token(base, "instagram.read");
  const listed = await rpc(base, instagramRead, "events/list", {});
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).result.events, [{ name: "instagram.message_received" }]);

  const subscribed = await rpc(base, instagramRead, "events/subscribe", {
    name: "instagram.message_received",
    arguments: { accountId: "101" },
    delivery: { mode: "webhook", url: "https://hooks.example.test/meta", secret: "fixture-secret" },
  });
  assert.equal(subscribed.status, 200);
  assert.deepEqual(events.calls.at(-1)[2].scopes, ["instagram.read"]);

  const denied = await rpc(base, instagramRead, "events/subscribe", {
    name: "facebook.message_received",
    arguments: { accountId: "202" },
    delivery: { mode: "webhook", url: "https://hooks.example.test/meta", secret: "fixture-secret" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="facebook\.read"/);
});

test("admin Meta routes merge safe console state and enforce OAuth-bound single-use CSRF", async (t) => {
  const { base, meta } = await fixture(t);
  const { cookie, get, post } = await admin(base);

  const consoleResponse = await get("/admin/api/console");
  assert.equal(consoleResponse.status, 200);
  const consoleState = await consoleResponse.json();
  assert.equal(consoleState.channels.instagram.status, "connected");
  assert.equal(consoleState.meta.revision, 7);
  assert.deepEqual(consoleState.meta.ownerIds, ["owner@s.whatsapp.net"]);
  assert.equal(consoleState.meta.conversations[0].lastMessage, undefined);
  assert.doesNotMatch(JSON.stringify(consoleState), /private message body/);

  let snapshot = await (await get("/admin/api/meta")).json();
  assert.equal(snapshot.metaRevision, 7);
  assert.equal(snapshot.metaConversations[0].lastMessage, undefined);
  assert.deepEqual(snapshot.ownerIds, ["owner@s.whatsapp.net"]);

  const crossSite = await post("/admin/api/meta", {
    csrf: snapshot.csrf, action: "begin-oauth", platform: "instagram",
  }, { origin: "https://attacker.invalid" });
  assert.equal(crossSite.status, 403);
  assert.equal(meta.calls.some((call) => call[0] === "begin"), false);

  const prototypeAction = await post("/admin/api/meta", {
    csrf: snapshot.csrf, action: "toString", platform: "instagram",
  });
  assert.equal(prototypeAction.status, 400);
  const afterPrototype = await prototypeAction.json();
  assert.ok(afterPrototype.csrf);

  const invalid = await post("/admin/api/meta", {
    csrf: afterPrototype.csrf, action: "begin-oauth", platform: "instagram", extra: true,
  });
  assert.equal(invalid.status, 400);
  const rotated = await invalid.json();
  assert.ok(rotated.csrf);
  assert.notEqual(rotated.csrf, snapshot.csrf);

  const begun = await post("/admin/api/meta", {
    csrf: rotated.csrf, action: "begin-oauth", platform: "instagram",
  });
  assert.equal(begun.status, 200);
  const begunBody = await begun.json();
  assert.match(begunBody.authorizationUrl, /^https:\/\/www\.instagram\.com\//);
  const beginCall = meta.calls.find((call) => call[0] === "begin");
  assert.match(beginCall[2], /^[a-f0-9]{64}$/);

  const completed = await post("/admin/api/meta", {
    csrf: begunBody.csrf, action: "complete-oauth", platform: "instagram", code: "provider-code", state: "provider-state",
  });
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  const completeCall = meta.calls.find((call) => call[0] === "complete");
  assert.equal(completeCall[2].sessionHash, beginCall[2]);
  assert.equal(completeCall[2].code, "provider-code");

  const updated = await post("/admin/api/meta", {
    csrf: completedBody.csrf, action: "set-replies", platform: "instagram", revision: 7, enabled: true,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(meta.calls.at(-1), ["update", { action: "set-replies", platform: "instagram", revision: 7, enabled: true }]);
  const updatedBody = await updated.json();
  const configSaved = await post("/admin/api/meta", {
    csrf: updatedBody.csrf, action: "save-config", platform: "instagram", revision: 8, appId: "1001",
  });
  assert.equal(configSaved.status, 200);
  assert.deepEqual(meta.calls.at(-1), ["update", { action: "save-config", platform: "instagram", revision: 8, appId: "1001" }]);

  const callback = await fetch(`${base}/admin/meta/callback/instagram?code=code&state=state`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /data-meta-callback-platform="instagram"/);
  const callbackAsset = await fetch(`${base}/admin/assets/meta-callback.js`);
  assert.equal(callbackAsset.status, 200);
  assert.match(callbackAsset.headers.get("content-type"), /text\/javascript/);
  assert.equal((await fetch(`${base}/admin/api/meta`, { headers: { cookie: "wa_admin=invalid" } })).status, 401);
});

test("Meta webhooks preserve exact signed bytes, reject bad HMACs and cap the raw body at 1 MiB", async (t) => {
  const { base, meta } = await fixture(t);
  const verification = await fetch(`${base}/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`);
  assert.equal(verification.status, 200);
  assert.equal(await verification.text(), "challenge-123");

  const raw = Buffer.from('{"object":"instagram","entry":[],"note":"\u96ea"}\n', "utf8");
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;
  const accepted = await fetch(`${base}/webhooks/meta/instagram`, {
    method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: raw,
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(Buffer.from(meta.calls.find((call) => call[0] === "webhook")[2]), raw);

  const rejected = await fetch(`${base}/webhooks/meta/instagram`, {
    method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: raw,
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "invalid_request" });

  const oversized = await fetch(`${base}/webhooks/meta/facebook`, {
    method: "POST", headers: { "x-hub-signature-256": signature }, body: Buffer.alloc(1024 * 1024 + 1, 0x61),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "invalid_request" });
});

test("private IG scopes remain independent from official Meta and WhatsApp grants", async (t) => {
  const { base, events } = await fixture(t, { privateInstagram: true });
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.ok(metadata.scopes_supported.includes("instagram.private.read"));
  assert.ok(metadata.scopes_supported.includes("instagram.private.send"));
  const officialToken = await token(base, "instagram.read events");
  const denied = await rpc(base, officialToken, "tools/call", { name: "instagram_private_status", arguments: {} });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="instagram\.private\.read"/);
  const ownToken = await token(base, "instagram.private.read events");
  const status = await (await rpc(base, ownToken, "tools/call", { name: "instagram_private_status", arguments: {} })).json();
  assert.equal(status.result.structuredContent.status, "not_configured");
  const listed = await (await rpc(base, ownToken, "tools/list", {})).json();
  assert.equal(listed.result.tools.filter((tool) => tool.name.startsWith("instagram_private_")).length, 8);
  const subscribed = await rpc(base, ownToken, "events/subscribe", { name: "instagram.group_message_received", arguments: { accountId: "101" } });
  assert.equal((await subscribed.json()).result.id, "subscription-1");
  assert.equal(events.calls.at(-1)[2].scopes.includes("instagram.private.read"), true);
});

test("private IG admin settings require admin, same origin and rotating CSRF", async (t) => {
  const { base, privateCalls } = await fixture(t, { privateInstagram: true });
  assert.equal((await fetch(`${base}/admin/api/instagram-private`)).status, 401);
  const { get, post } = await admin(base);
  const consoleState = await (await get("/admin/api/console")).json();
  assert.equal(consoleState.channels.instagramPrivate.status, "not_configured");
  assert.deepEqual(consoleState.instagramPrivate.ownerIds, ["owner@s.whatsapp.net"]);
  let snapshot = await (await get("/admin/api/instagram-private")).json();
  assert.equal((await post("/admin/api/instagram-private", { csrf: snapshot.csrf, revision: 1, action: "set-replies", enabled: true }, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal(privateCalls.length, 0);
  const invalid = await post("/admin/api/instagram-private", { csrf: snapshot.csrf, revision: 1, action: "toString" });
  assert.equal(invalid.status, 400);
  snapshot = await invalid.json();
  const saved = await post("/admin/api/instagram-private", { csrf: snapshot.csrf, revision: 1, action: "configure", expectedAccountId: "101" });
  assert.equal(saved.status, 200);
  assert.deepEqual(privateCalls, [{ revision: 1, action: "configure", expectedAccountId: "101" }]);
  assert.equal((await post("/admin/api/instagram-private", { csrf: snapshot.csrf, revision: 1, action: "configure", expectedAccountId: "101" })).status, 403);
  const asset = await fetch(`${base}/admin/assets/instagram-private.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /text\/javascript/);
});
