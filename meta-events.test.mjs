import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MetaEventSubscriptions, SocialEventRouter, eventReadScope } from "./meta-events.mjs";

const SECRET_KEY = Buffer.alloc(32, 197);
const SECRET = `whsec_${SECRET_KEY.toString("base64")}`;
const ACCOUNT_A = "17841400000000001";
const ACCOUNT_B = "17841400000000002";
const SENDER_A = "10000000000000001";
const SENDER_B = "10000000000000002";

function echoVerification(request) {
  const body = JSON.parse(request.body);
  if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  return { status: 204, body: "" };
}

function subscription(platform, args, url = `https://${platform}.example.test/events`) {
  return {
    name: `${platform}.message_received`,
    arguments: args,
    delivery: { mode: "webhook", url, secret: SECRET },
    cursor: null,
  };
}

function metaMessage(platform = "instagram", overrides = {}) {
  const accountId = overrides.accountId ?? ACCOUNT_A;
  const senderId = overrides.senderId ?? SENDER_A;
  return {
    platform,
    accountId,
    chatId: `${platform}:${accountId}:${senderId}`,
    id: "mid-provider-1",
    senderId,
    text: "hello",
    timestamp: 1_800_000_000_123,
    fromMe: false,
    type: "text",
    permission: {
      mode: "rules_only",
      actorLevel: "L2",
      roomLevel: "L2",
      effectiveLevel: "L2",
      audience: "private",
      actorIsOwner: false,
      policyValid: true,
      privateDataAllowed: false,
      managePermissionsAllowed: false,
    },
    replyAllowed: true,
    ...overrides,
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}

test("persists Instagram and Facebook subscriptions in independent state files", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-meta-events-state-"));
  const common = {
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: echoVerification,
    logger: { error() {} },
  };
  const instagram = new MetaEventSubscriptions({ platform: "instagram", ...common });
  const facebook = new MetaEventSubscriptions({ platform: "facebook", ...common });
  try {
    await Promise.all([instagram.start(), facebook.start()]);
    await instagram.subscribe(subscription("instagram", { accountId: ACCOUNT_A }), "owner");
    await facebook.subscribe(subscription("facebook", { chatIds: [`facebook:${ACCOUNT_B}:${SENDER_B}`] }), "owner");
    await Promise.all([instagram.stop(), facebook.stop()]);

    assert.equal((await fs.stat(path.join(dataDir, "events-instagram-state.json"))).isFile(), true);
    assert.equal((await fs.stat(path.join(dataDir, "events-facebook-state.json"))).isFile(), true);
    await assert.rejects(fs.stat(path.join(dataDir, "events-state.json")), { code: "ENOENT" });

    const restoredInstagram = new MetaEventSubscriptions({ platform: "instagram", ...common });
    const restoredFacebook = new MetaEventSubscriptions({ platform: "facebook", ...common });
    await Promise.all([restoredInstagram.start(), restoredFacebook.start()]);
    assert.equal(restoredInstagram.stats().subscriptions, 1);
    assert.equal(restoredFacebook.stats().subscriptions, 1);
    assert.equal(restoredInstagram.list().events[0].name, "instagram.message_received");
    assert.equal(restoredFacebook.list().events[0].name, "facebook.message_received");
    await Promise.all([restoredInstagram.stop(), restoredFacebook.stop()]);
  } finally {
    await Promise.all([instagram.stop().catch(() => {}), facebook.stop().catch(() => {})]);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("signs a bounded safe Meta payload and applies exact account and chat filters", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-meta-events-safe-"));
  const requests = [];
  const manager = new MetaEventSubscriptions({
    platform: "instagram",
    dataDir,
    now: () => 1_800_000_100_000,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return echoVerification(request);
      requests.push(request);
      return { status: 204, body: "" };
    },
    logger: { error() {} },
  });
  try {
    await manager.start();
    const accountSubscription = await manager.subscribe(
      subscription("instagram", { accountId: ACCOUNT_A }, "https://account.example.test/events"),
      "owner",
    );
    const chatSubscription = await manager.subscribe(
      subscription("instagram", { chatIds: [`instagram:${ACCOUNT_B}:${SENDER_B}`] }, "https://chat.example.test/events"),
      "owner",
    );
    await assert.rejects(
      manager.subscribe(subscription("instagram", {
        accountId: ACCOUNT_A,
        chatIds: [`instagram:${ACCOUNT_B}:${SENDER_B}`],
      }), "owner"),
      { code: -32602 },
    );

    await manager.publish(metaMessage("instagram", {
      accessToken: "must-not-leak",
      mediaUrl: "https://private.example/media",
      pushName: "Owner",
      senderRole: "owner",
      mediaType: "image",
      media: { mimetype: "image/jpeg", fileName: "photo.jpg", url: "https://private.example/photo.jpg" },
      permission: {
        ...metaMessage().permission,
        credentials: { token: "must-not-leak" },
      },
    }));
    await manager.publish(metaMessage("instagram", {
      accountId: ACCOUNT_B,
      senderId: SENDER_B,
      chatId: `instagram:${ACCOUNT_B}:${SENDER_B}`,
      id: "mid-provider-2",
    }));
    await waitUntil(() => requests.length === 2);

    const bySubscription = new Map(requests.map((request) => [request.headers["X-MCP-Subscription-Id"], request]));
    assert.equal(bySubscription.has(accountSubscription.id), true);
    assert.equal(bySubscription.has(chatSubscription.id), true);
    const delivery = bySubscription.get(accountSubscription.id);
    const event = JSON.parse(delivery.body);
    assert.deepEqual(Object.keys(event.data).sort(), [
      "accountId", "chatId", "fromMe", "id", "media", "mediaType", "permission", "platform", "replyAllowed", "senderId", "text", "timestamp", "type",
    ]);
    assert.deepEqual(event.data.media, { mimetype: "image/jpeg", fileName: "photo.jpg" });
    assert.deepEqual(event.data.permission, metaMessage().permission);
    assert.equal(event.data.senderRole, undefined);
    assert.equal(event.data.pushName, undefined);
    assert.equal(event.data.accessToken, undefined);
    assert.equal(event.data.mediaUrl, undefined);
    assert.equal(event.name, "instagram.message_received");
    assert.match(event.eventId, /^evt_instagram_/);

    const timestamp = delivery.headers["webhook-timestamp"];
    const expected = createHmac("sha256", SECRET_KEY)
      .update(`${event.eventId}.${timestamp}.${delivery.body}`)
      .digest("base64");
    assert.equal(delivery.headers["webhook-signature"], `v1,${expected}`);
  } finally {
    await manager.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("drops own, history, false-reply and forged Meta messages before delivery", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-meta-events-filter-"));
  let deliveries = 0;
  const manager = new MetaEventSubscriptions({
    platform: "facebook",
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return echoVerification(request);
      deliveries += 1;
      return { status: 204, body: "" };
    },
    logger: { error() {} },
  });
  try {
    await manager.start();
    await manager.subscribe(subscription("facebook", { accountId: ACCOUNT_A }), "owner");
    const incoming = metaMessage("facebook");
    assert.deepEqual(await manager.publish({ ...incoming, fromMe: true }), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await manager.publish({ ...incoming, id: "history", type: "history" }), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await manager.publish({ ...incoming, id: "revoked", replyAllowed: false }), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await manager.publish({ ...incoming, id: "forged", chatId: `facebook:${ACCOUNT_B}:${SENDER_A}` }), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await manager.publish({ ...incoming, id: "wrong-platform", platform: "instagram" }), { queued: 0, dropped: 0, filtered: true });
    await assert.rejects(manager.publish({ ...incoming, id: "bad-permission", permission: { ...incoming.permission, policyValid: false } }), { code: -32602 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries, 0);
  } finally {
    await manager.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("restores pending Meta deliveries and drops them when delivery permission is revoked or cannot be checked", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-meta-events-gate-"));
  const common = {
    platform: "instagram",
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    logger: { error() {} },
  };
  const first = new MetaEventSubscriptions({ ...common, transport: echoVerification });
  await first.start();
  await first.subscribe(subscription("instagram", { accountId: ACCOUNT_A }), "owner");
  await first.stop();
  await first.publish(metaMessage("instagram", { id: "revoked-before-delivery" }));
  await first.publish(metaMessage("instagram", { id: "gate-error-before-delivery", senderId: SENDER_B, chatId: `instagram:${ACCOUNT_A}:${SENDER_B}` }));

  const checked = [];
  let deliveries = 0;
  const second = new MetaEventSubscriptions({
    ...common,
    canDeliver(message) {
      checked.push(message.id);
      if (message.id === "gate-error-before-delivery") throw new Error("bridge unavailable");
      return false;
    },
    transport: async () => {
      deliveries += 1;
      return { status: 204, body: "" };
    },
  });
  try {
    await second.start();
    await waitUntil(() => second.stats().pendingDeliveries === 0);
    assert.deepEqual(checked.sort(), ["gate-error-before-delivery", "revoked-before-delivery"]);
    assert.equal(deliveries, 0);
    assert.equal(second.stats().failedDeliveries, 0);
  } finally {
    await second.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("routes discovery, authorization, lifecycle and Meta publishing by event namespace", async () => {
  const calls = [];
  const provider = (platform) => ({
    list() {
      calls.push(["list", platform]);
      return { events: [{ name: `${platform}.message_received` }] };
    },
    subscribe(params, principal) {
      calls.push(["subscribe", platform, params.name, principal]);
      return { id: `sub-${platform}` };
    },
    unsubscribe(params, principal) {
      calls.push(["unsubscribe", platform, params.name, principal]);
      return {};
    },
    start() {
      calls.push(["start", platform]);
    },
    stop() {
      calls.push(["stop", platform]);
    },
    publish(message) {
      calls.push(["publish", platform, message.id]);
      return { queued: 1, dropped: 0 };
    },
  });
  const router = new SocialEventRouter({
    whatsapp: provider("whatsapp"),
    instagram: provider("instagram"),
    facebook: provider("facebook"),
  });
  const principal = { id: "oauth-owner", scopes: ["whatsapp.read", "instagram.read"] };

  assert.deepEqual(router.list({}, principal).events.map(({ name }) => name), [
    "whatsapp.message_received",
    "instagram.message_received",
  ]);
  assert.deepEqual(await router.subscribe({ name: "instagram.message_received" }, principal), { id: "sub-instagram" });
  assert.deepEqual(await router.unsubscribe({ name: "whatsapp.message_received" }, principal), {});
  assert.throws(() => router.subscribe({ name: "facebook.message_received" }, principal), { code: -32024 });
  assert.throws(() => router.subscribe({ name: "unknown.message_received" }, principal), { code: -32023 });
  assert.deepEqual(await router.publishMeta({ platform: "facebook", id: "meta-1" }), { queued: 1, dropped: 0 });
  await router.start();
  await router.stop();

  assert.equal(calls.some((call) => call.join(":") === "subscribe:instagram:instagram.message_received:oauth-owner"), true);
  assert.equal(calls.some((call) => call.join(":") === "unsubscribe:whatsapp:whatsapp.message_received:oauth-owner"), true);
  assert.equal(calls.some((call) => call.join(":") === "publish:facebook:meta-1"), true);
  assert.equal(eventReadScope("whatsapp.message_received"), "whatsapp.read");
  assert.equal(eventReadScope("instagram.message_received"), "instagram.read");
  assert.equal(eventReadScope("facebook.message_received"), "facebook.read");
  assert.equal(eventReadScope("unknown.message_received"), null);
});
