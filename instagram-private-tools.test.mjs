import assert from "node:assert/strict";
import test from "node:test";
import { downloadFile, MediaStore, MAX_IMAGE_BYTES } from "./media.mjs";
import { callInstagramPrivateTool, INSTAGRAM_PRIVATE_TOOLS, instagramPrivateToolScope } from "./instagram-private-tools.mjs";

const chatId = "instagram_private:101:dm:201";
const sourceMessageId = "source-1";
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const file = { download_url: "https://files.example/image.png", file_id: "image-1" };
const media = () => new MediaStore({ publicUrl: "https://bridge.example" });

test("private IG tools use independent scopes and source-bound send arguments", async () => {
  assert.equal(INSTAGRAM_PRIVATE_TOOLS.length, 8);
  assert.equal(instagramPrivateToolScope("instagram_private_get_messages"), "instagram.private.read");
  assert.equal(instagramPrivateToolScope("instagram_private_send_image"), "instagram.private.send");
  assert.equal(instagramPrivateToolScope("instagram_send_image"), null);
  const calls = [];
  const bridge = { sendText: async (args) => { calls.push(args); return { sent: true }; } };
  const invoke = (name, args) => callInstagramPrivateTool({ name, args, bridge });
  for (const [name, args] of [
    [null, {}],
    ["instagram_private_send_text", { chatId, text: "hello", idempotencyKey: "test-key" }],
    ["instagram_private_send_text", { chatId, sourceMessageId, text: "hello", idempotencyKey: "test-key", owner: true }],
    ["instagram_private_send_text", { chatId, sourceMessageId, text: "hello", idempotencyKey: "short" }],
  ]) await assert.rejects(invoke(name, args), { rpcCode: -32602 });
  assert.equal(calls.length, 0);
  await invoke("instagram_private_send_text", { chatId, sourceMessageId, text: "hello", idempotencyKey: "test-key" });
  assert.equal(calls[0].sourceMessageId, sourceMessageId);
});

test("private IG sends only bounded image bytes to the worker bridge", async () => {
  const sends = [];
  const bridge = { sendImage: async (args) => { sends.push(args); return { sent: true }; } };
  const invoke = (data) => callInstagramPrivateTool({
    name: "instagram_private_send_image", bridge,
    args: { chatId, sourceMessageId, file, idempotencyKey: "test-image-key" },
    mediaDownloader: async (_file, options) => {
      assert.equal(options.maximum, MAX_IMAGE_BYTES);
      return { data, mimetype: "image/png", fileName: "image.png" };
    },
  });
  await assert.rejects(invoke(Buffer.from("not an image")), { rpcCode: -32602 });
  await assert.rejects(invoke(Buffer.alloc(MAX_IMAGE_BYTES + 1)), { rpcCode: -32602 });
  await invoke(png);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].mimetype, "image/png");
  assert.equal(Buffer.isBuffer(sends[0].data), true);
  assert.equal(JSON.stringify(sends).includes(file.download_url), false);
});

test("private IG media strips provider URLs and rechecks permission after downloading", async () => {
  let allowed = true;
  const privateUrl = "https://provider.example/private-token";
  const bridge = { getMediaDescriptor: async () => allowed ? { url: privateUrl, mimetype: "image/png", fileName: "photo.png", mediaType: "image" } : null };
  const invoke = (revoke) => callInstagramPrivateTool({
    name: "instagram_private_get_media", args: { chatId, messageId: sourceMessageId }, bridge, media: media(),
    mediaDownloader: async (descriptor, options) => {
      const downloaded = await downloadFile(descriptor, {
        ...options,
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: png }),
      });
      if (revoke) allowed = false;
      return downloaded;
    },
  });
  const result = await invoke(false);
  assert.equal(result.content[0].type, "image");
  assert.match(result.content[1].uri, /^https:\/\/bridge\.example\/media\//);
  assert.equal(JSON.stringify(result).includes(privateUrl), false);
  await assert.rejects(invoke(true), { status: 403 });
});
