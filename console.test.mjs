import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./server.mjs";

const ADMIN_TOKEN = "local-console-test-password";
const ORIGIN = "http://localhost:4395";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "dot-console-http-"));
  let revision = "initial";
  const writes = [];
  const bridge = {
    getQr: () => null,
    getConsoleState: () => ({
      revision,
      channels: { whatsapp: { status: "disconnected", autoReplyEnabled: true }, instagram: { status: "not_configured", available: false } },
      permissions: { valid: true, mode: "rules_only", defaultLevel: "L5" },
      users: [], groups: [],
    }),
    async updateConsoleSettings(change) {
      if (change.revision !== revision) throw Object.assign(new Error("conflict"), { status: 409 });
      if (change.enabled === "invalid") throw Object.assign(new Error("private path must not leak"), { status: 400 });
      if (change.enabled === "crash") throw new Error("secret must not leak");
      writes.push(change);
      revision = `revision-${writes.length}`;
    },
  };
  const server = await createApp({ bridge, events: {}, config: { dataDir, publicUrl: ORIGIN, adminToken: ADMIN_TOKEN, allowInsecureHttp: true } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/admin/login`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ admin_token: ADMIN_TOKEN }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const get = () => fetch(`${base}/admin/api/console`, { headers: { cookie } });
  const post = (payload, headers = {}) => fetch(`${base}/admin/api/console`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { base, cookie, get, post, writes };
}

test("console data requires an admin session and assets expose no configuration", async (t) => {
  const { base, cookie, get } = await fixture(t);
  for (const headers of [{}, { authorization: "Bearer irrelevant-oauth-token" }]) {
    const denied = await fetch(`${base}/admin/api/console`, { headers });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.equal((await denied.json()).csrf, undefined);
  }
  const response = await get();
  assert.equal(response.status, 200);
  assert.ok((await response.json()).csrf);
  const html = await fetch(`${base}/admin`, { headers: { cookie } });
  const csp = html.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'; connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  const text = await html.text();
  assert.match(text, /name="csrf" value="[^"]+"/);
  assert.doesNotMatch(text, /"revision":"initial"|name="admin_token"/);
  for (const [file, type] of [["console.css", "text/css"], ["console.js", "text/javascript"]]) {
    const asset = await fetch(`${base}/admin/assets/${file}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), new RegExp(type));
    assert.doesNotMatch(await asset.text(), new RegExp(ADMIN_TOKEN));
  }
  assert.equal((await fetch(`${base}/admin/assets/auth.mjs`)).status, 404);
});

test("console writes enforce origin, JSON, single-use CSRF and action allowlist", async (t) => {
  const { post, get, writes } = await fixture(t);
  let state = await (await get()).json();
  const change = { csrf: state.csrf, revision: state.revision, action: "set-replies", enabled: false };
  assert.equal((await post(change, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await post(change, { origin: "null" })).status, 403);
  assert.equal((await post(change, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(change, { "content-type": "text/plain" })).status, 415);
  assert.equal(writes.length, 0);
  const saved = await post(change);
  assert.equal(saved.status, 200);
  state = await saved.json();
  assert.notEqual(state.csrf, change.csrf);
  assert.equal((await post(change)).status, 403);
  assert.equal(writes.length, 1);
  const rejected = await post({ csrf: state.csrf, revision: state.revision, action: "set-replies", enabled: true, ownerIds: ["forged"] });
  assert.equal(rejected.status, 400);
  state = await rejected.json();
  assert.ok(state.csrf);
  assert.equal(writes.length, 1);
  assert.equal((await post({ csrf: state.csrf, revision: "initial", action: "set-replies", enabled: true })).status, 409);
});

test("validation errors rotate CSRF for retry and hide private errors", async (t) => {
  const { get, post, writes } = await fixture(t);
  let state = await (await get()).json();
  for (const [enabled, status] of [["invalid", 400], ["crash", 500]]) {
    const response = await post({ csrf: state.csrf, revision: "initial", action: "set-replies", enabled });
    assert.equal(response.status, status);
    const next = await response.json();
    assert.ok(next.csrf);
    assert.notEqual(next.csrf, state.csrf);
    assert.doesNotMatch(JSON.stringify(next), /private path|secret/);
    state = next;
  }
  const retried = await post({ csrf: state.csrf, revision: "initial", action: "set-replies", enabled: true });
  assert.equal(retried.status, 200);
  assert.equal(writes.length, 1);
});
