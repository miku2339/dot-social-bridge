import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { downloadFile, MediaStore, MAX_IMAGE_BYTES, MAX_MEDIA_BYTES } from "./media.mjs";
import { callMetaTool, META_TOOLS, metaToolScope } from "./meta-tools.mjs";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const chatId = "instagram:101:301";
const sourceMessageId = "incoming-1";
const file = { download_url: "https://files.example/image.png", file_id: "image-1" };
const media = () => new MediaStore({ publicUrl: "https://bridge.example" });

test("Meta tool definitions retain distinct read/write scopes and exact schemas", () => {
  assert.equal(META_TOOLS.length, 14);
  for (const platform of ["instagram", "facebook"]) {
    assert.equal(metaToolScope(`${platform}_get_messages`), `${platform}.read`);
    assert.equal(metaToolScope(`${platform}_send_image`), `${platform}.send`);
    const send = META_TOOLS.find((tool) => tool.name === `${platform}_send_text`);
    assert.ok(send.inputSchema.required.includes("sourceMessageId"));
    assert.equal(send.inputSchema.additionalProperties, false);
  }
  assert.equal(metaToolScope("whatsapp_send_text"), null);
});

test("image sends fingerprint bytes while exposing only a short-lived bridge URL", async () => {
  const sends = [];
  const cache = media();
  const bridge = { sendImage: async (args) => { sends.push(args); return { sent: true }; } };
  const params = {
    name: "instagram_send_image", bridge, media: cache,
    mediaDownloader: async (_file, options) => {
      assert.equal(options.maximum, MAX_IMAGE_BYTES);
      return { data: png, fileName: "image.png", mimetype: "image/png" };
    },
    args: { chatId, sourceMessageId, file, idempotencyKey: "same-image-key" },
  };
  await callMetaTool(params);
  await callMetaTool(params);
  assert.notEqual(sends[0].imageUrl, sends[1].imageUrl);
  assert.equal(sends[0].imageDigest, sends[1].imageDigest);
  assert.equal(sends[0].imageDigest, createHash("sha256").update(png).digest("hex"));
  assert.match(sends[0].imageUrl, /^https:\/\/bridge\.example\/media\/[A-Za-z0-9_-]{43}$/);
  assert.equal(sends[0].platform, "instagram");
});

test("Meta tool validation rejects unsupported fields, unsafe source arguments and non-image bytes", async () => {
  let sends = 0;
  const bridge = { sendText: async () => { sends += 1; }, sendImage: async () => { sends += 1; } };
  const invoke = (name, args, data = png) => callMetaTool({
    name, args, bridge, media: media(), mediaDownloader: async () => ({ data }),
  });
  for (const args of [
    { chatId, text: "hello", idempotencyKey: "valid-key" },
    { chatId, sourceMessageId, text: "hello", idempotencyKey: "valid-key", owner: true },
    { chatId, sourceMessageId, text: "hello", idempotencyKey: "short" },
  ]) await assert.rejects(invoke("instagram_send_text", args), { rpcCode: -32602 });
  for (const data of [Buffer.from("not an image"), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) {
    await assert.rejects(invoke("instagram_send_image", { chatId, sourceMessageId, file, idempotencyKey: "valid-key" }, data), { rpcCode: -32602 });
  }
  assert.equal(sends, 0);
});

test("media reads bound provider downloads and return rehosted resources without private URLs", async () => {
  const cache = media();
  const privateUrl = "https://cdn.example/private-provider-token";
  const bridge = { getMediaDescriptor: () => ({ download_url: privateUrl, file_id: "provider-1", mediaType: "image" }) };
  const received = await callMetaTool({
    name: "instagram_get_media", args: { chatId, messageId: sourceMessageId }, bridge, media: cache,
    mediaDownloader: async (descriptor, options) => {
      assert.equal(descriptor.download_url, privateUrl);
      assert.equal(options.maximum, MAX_IMAGE_BYTES);
      return downloadFile(descriptor, {
        ...options,
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: png }),
      });
    },
  });
  assert.equal(received.content[0].type, "image");
  assert.equal(received.content[1].type, "resource_link");
  assert.equal(JSON.stringify(received).includes(privateUrl), false);
  assert.match(received.content[1].uri, /^https:\/\/bridge\.example\/media\//);
  bridge.getMediaDescriptor = () => ({ download_url: privateUrl, file_id: "document-1", mediaType: "document" });
  await callMetaTool({
    name: "facebook_get_media", args: { chatId: "facebook:202:301", messageId: sourceMessageId }, bridge, media: cache,
    mediaDownloader: async (_descriptor, options) => {
      assert.equal(options.maximum, MAX_MEDIA_BYTES);
      return { data: Buffer.from("document"), mimetype: "application/pdf", fileName: "document.pdf" };
    },
  });
});
