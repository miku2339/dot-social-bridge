import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppBridge } from "./bridge.mjs";
import { MetaBridge } from "./meta-bridge.mjs";
import { InstagramPrivateBridge } from "./instagram-private.mjs";
import { createApp } from "./server.mjs";

// Preview uses an isolated temporary store and never opens a WhatsApp socket.
const port = 4395;
const dataDir = await mkdtemp(join(tmpdir(), "dot-console-preview-"));
const ownerId = "100000000000001@lid";
const userId = "200000000000002@lid";
const groupId = "300000000000003@g.us";
const adminToken = "console-preview-password";
const writeFixture = (name, document) => writeFile(join(dataDir, name), `${JSON.stringify(document)}\n`, { mode: 0o600 });

await writeFixture("owner-identities.json", {
  version: 1, ownerIds: [ownerId], allowOwnerGroups: true, mentionOnlyGroupIds: [groupId],
});
await writeFixture("access-policy.json", {
  version: 1,
  userLevels: { [userId]: "L4" },
  userProfiles: { [userId]: { displayName: "示範協作者", instagramUsername: "demo_collaborator" } },
  roomLevels: { [groupId]: "L4" },
});
await writeFixture("store.json", {
  version: 1, messages: [], idempotency: {},
  chats: { [groupId]: { id: groupId, name: "示範專案群組", updatedAt: Date.now(), lastMessage: null } },
});

const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };
const socket = { ev: new EventEmitter(), user: { id: "400000000000004@s.whatsapp.net", name: "Dot 示範帳戶" }, end() {} };
const bridge = new WhatsAppBridge({
  dataDir,
  logger,
  socketFactory: () => socket,
  authStateFactory: async () => ({ state: { creds: { registered: true }, keys: {} }, async saveCreds() {} }),
  downloadContentFromMessage: async () => { throw new Error("Media is unavailable in preview"); },
  disconnectReason: { loggedOut: 401 },
});
await bridge.start();
socket.ev.emit("connection.update", { connection: "open" });
const metaBridge = new MetaBridge({
  dataDir, publicUrl: `http://localhost:${port}`, allowInsecureHttp: true,
  ownerIds: () => [ownerId],
  fetchImpl: async () => { throw new Error("External authorization is unavailable in preview"); },
});
await metaBridge.start();
const instagramPrivateBridge = new InstagramPrivateBridge({
  dataDir, ownerIds: () => [ownerId],
  worker: { request: async () => ({ status: "not_configured", account: null }), stop: async () => {} },
});
await instagramPrivateBridge.start();
const server = await createApp({
  bridge,
  metaBridge,
  instagramPrivateBridge,
  events: {},
  config: { dataDir, publicUrl: `http://localhost:${port}`, adminToken, allowInsecureHttp: true, consolePreview: true },
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  await bridge.stop();
  await metaBridge.stop();
  await instagramPrivateBridge.stop();
  await rm(dataDir, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
server.once("error", async (error) => {
  await close();
  process.exitCode = 1;
  console.error(error.code || "Preview startup failed");
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Local preview: http://localhost:${port}/admin`);
  console.log(`Preview password: ${adminToken}`);
});
