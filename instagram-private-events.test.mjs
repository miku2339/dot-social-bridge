import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstagramPrivateEvents } from "./instagram-private-events.mjs";
import { SocialEventRouter } from "./meta-events.mjs";

const key = Buffer.alloc(32, 197);
const secret = `whsec_${key.toString("base64")}`;
const eventName = (kind) => kind === "group" ? "instagram.group_message_received" : "instagram.private_message_received";
const subscription = (kind, args = { accountId: "101" }) => ({
  name: eventName(kind), arguments: args, cursor: null,
  delivery: { mode: "webhook", url: "https://callback.example/events", secret },
});
function message(kind = "dm", overrides = {}) {
  return {
    platform: "instagram_private", accountId: "101", chatId: `instagram_private:101:${kind}:201`,
    id: `source-${kind}`, senderId: "301", text: "hello", timestamp: Date.now(),
    fromMe: false, isGroup: kind === "group", type: "text", replyAllowed: true,
    permission: { mode: "rules_only", actorLevel: "L5", roomLevel: "L5", effectiveLevel: "L5",
      audience: kind === "group" ? "group" : "private", actorIsOwner: false, policyValid: true,
      privateDataAllowed: false, managePermissionsAllowed: false },
    ...overrides,
  };
}
async function fixture(t, canDeliver = async () => true) {
  const dataDir = await mkdtemp(join(tmpdir(), "dot-private-events-"));
  const deliveries = [];
  const events = new InstagramPrivateEvents({
    dataDir, canDeliver, logger: { error() {} },
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
      deliveries.push(request);
      return { status: 204, body: "" };
    },
  });
  await events.start();
  t.after(async () => { await events.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return { events, deliveries, dataDir };
}
async function waitUntil(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("event delivery timed out");
}

test("private IG routes DM/group independently and signs sanitized durable payloads", async (t) => {
  const { events, deliveries, dataDir } = await fixture(t);
  await events.subscribe(subscription("dm"), "owner");
  await events.subscribe(subscription("group"), "owner");
  await events.publish(message("dm", { session: "must-not-leak", media: { url: "https://private.example/token", mimetype: "image/png" } }));
  await events.publish(message("group"));
  await waitUntil(() => deliveries.length === 2);
  for (const request of deliveries) {
    const event = JSON.parse(request.body);
    assert.equal(event.data.session, undefined);
    assert.equal(JSON.stringify(event).includes("https://private.example/token"), false);
    assert.equal(event.name, eventName(event.data.isGroup ? "group" : "dm"));
    assert.match(event.data.timestamp, /^\d{4}-/);
    const signature = createHmac("sha256", key).update(`${event.eventId}.${request.headers["webhook-timestamp"]}.${request.body}`).digest("base64");
    assert.equal(request.headers["webhook-signature"], `v1,${signature}`);
  }
  for (const kind of ["dm", "group"]) {
    assert.ok(JSON.parse(await readFile(join(dataDir, `events-instagram-private-${kind}-state.json`), "utf8")));
  }
});

test("private IG event subscriptions reject mixed namespaces and coercible IDs", async (t) => {
  const { events } = await fixture(t);
  for (const args of [{ accountId: 101 }, { accountId: "101", chatIds: ["instagram:101:201"] },
    { accountId: "101", chatIds: ["instagram_private:102:dm:201"] },
    { accountId: "101", chatIds: ["instagram_private:101:group:201"] }]) {
    await assert.rejects(events.subscribe(subscription("dm", args), "owner"), { code: -32602 });
  }
  await assert.rejects(events.publish(message("dm", { senderId: 301 })), { code: -32602 });
  const group = message("group");
  await assert.rejects(events.publish({ ...group, permission: { ...group.permission, privateDataAllowed: true } }), { code: -32602 });
});

test("private IG events require their own read grant and fresh delivery permission", async (t) => {
  const { events, deliveries } = await fixture(t, async () => false);
  const router = new SocialEventRouter({ instagramPrivate: events });
  const official = { id: "owner", scopes: ["instagram.read", "events"] };
  assert.deepEqual(router.list({}, official), { events: [] });
  assert.throws(() => router.subscribe(subscription("dm"), official), { code: -32024 });
  const principal = { id: "owner", scopes: ["instagram.private.read", "events"] };
  assert.equal(router.list({}, principal).events.length, 2);
  await router.subscribe(subscription("dm"), principal);
  await router.publishInstagramPrivate(message());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(deliveries.length, 0);
});
