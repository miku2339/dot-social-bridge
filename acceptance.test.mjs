import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuthManager } from "./auth.mjs";
import { createApp } from "./server.mjs";

const redirect = "https://chatgpt.com/connector_platform/oauth/callback";
const adminToken = "acceptance-test-admin-token";
const metadata = { client_name: "Deployment acceptance", redirect_uris: [redirect] };

test("reuses the local deployment client across simultaneous PKCE checks and replaces a stale ID", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "acceptance-"));
  const listener = createServer();
  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const publicUrl = `http://127.0.0.1:${listener.address().port}`;
  const app = await createApp({
    bridge: { getStatus: () => ({ status: "disconnected", paired: false }) },
    events: { list: () => ({ events: [] }) },
    config: { publicUrl, dataDir, adminToken, allowInsecureHttp: true },
  });
  listener.on("request", (req, res) => app.emit("request", req, res));
  const tokenFile = join(dataDir, "admin.token");
  await writeFile(tokenFile, adminToken, { mode: 0o600 });
  const run = async () => {
    const { stdout } = await promisify(execFile)("python3", [fileURLToPath(new URL("./acceptance.py", import.meta.url))], {
      env: { ...process.env, PUBLIC_URL: publicUrl, ADMIN_TOKEN_FILE: tokenFile, XDG_CACHE_HOME: dataDir },
    });
    assert.equal(JSON.parse(stdout).oauth_pkce, "passed");
  };
  await Promise.all([run(), run()]);
  const readState = async () => JSON.parse(await readFile(join(dataDir, "auth-state.json"), "utf8"));
  const first = await readState();
  assert.equal(Object.keys(first.clients).length, 1);
  assert.equal(Object.keys(first.accessTokens).length, 2);
  const cacheDir = join(dataDir, "dot-social-bridge");
  const cache = (await readdir(cacheDir)).find((name) => name.startsWith("acceptance-client-"));
  assert.equal(await readFile(join(cacheDir, cache), "utf8"), Object.keys(first.clients)[0]);
  await writeFile(join(cacheDir, cache), `client_${"x".repeat(32)}`);
  await run();
  const restored = await readState();
  assert.equal(Object.keys(restored.clients).length, 2);
  assert.equal(Object.keys(restored.accessTokens).length, 3);
});

test("reclaims only expired unused acceptance registrations while preserving ongoing authorization and refresh", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "acceptance-registry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.now();
  const auth = await createAuthManager({ publicUrl: "https://bridge.example", dataDir, adminToken, now: () => now });
  const normal = await auth.registerClient({ ...metadata, client_name: "Connector" });
  const active = await auth.registerClient(metadata);
  const pending = await auth.registerClient(metadata);
  assert.notEqual(active.client_id, pending.client_id);
  for (let i = 3; i < 100; i++) await auth.registerClient(metadata);
  await assert.rejects(auth.registerClient(metadata), (error) => error.status === 429);
  now += 31 * 24 * 60 * 60_000;
  const verifier = "v".repeat(64);
  const request = {
    response_type: "code", scope: "whatsapp.read", redirect_uri: redirect, resource: auth.resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  };
  const { csrf } = await auth.beginAuthorization({ ...request, client_id: active.client_id });
  const { code } = await auth.approveAuthorization({ csrf, admin_token: adminToken });
  const tokens = await auth.exchangeToken({
    grant_type: "authorization_code", client_id: active.client_id, code, code_verifier: verifier,
    resource: auth.resource, redirect_uri: redirect,
  });
  const ongoing = await auth.beginAuthorization({ ...request, client_id: pending.client_id });
  await auth.registerClient(metadata);
  const state = JSON.parse(await readFile(join(dataDir, "auth-state.json"), "utf8"));
  assert.equal(Object.keys(state.clients).length, 100);
  for (const client of [normal, active, pending]) assert.ok(state.clients[client.client_id]);
  await auth.approveAuthorization({ csrf: ongoing.csrf, admin_token: adminToken });
  await auth.exchangeToken({ grant_type: "refresh_token", client_id: active.client_id, refresh_token: tokens.refresh_token, resource: auth.resource });
});
