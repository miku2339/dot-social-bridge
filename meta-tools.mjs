import { createHash } from "node:crypto";
import { MAX_IMAGE_BYTES, MAX_MEDIA_BYTES } from "./media.mjs";

const FILE_SCHEMA = {
  type: "object",
  properties: { download_url: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } },
  required: ["download_url", "file_id"], additionalProperties: false,
};
const ID = { type: "string", minLength: 1, maxLength: 500 };
const CHAT = { type: "string", minLength: 1, maxLength: 160 };
const KEY = { type: "string", minLength: 8, maxLength: 128 };
const OPERATIONS = {
  status: { title: "連線狀態", properties: {}, required: [] },
  list_chats: { title: "對話清單", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, required: [] },
  get_messages: { title: "讀取訊息", properties: { chatId: CHAT, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["chatId"] },
  get_pending_replies: { title: "待回覆訊息", properties: { after: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["after"] },
  get_media: { title: "讀取媒體", properties: { chatId: CHAT, messageId: ID }, required: ["chatId", "messageId"] },
  send_text: { title: "回覆文字", properties: { chatId: CHAT, sourceMessageId: ID, text: { type: "string", minLength: 1, maxLength: 2000 }, idempotencyKey: KEY }, required: ["chatId", "sourceMessageId", "text", "idempotencyKey"], write: true },
  send_image: { title: "回覆圖片", properties: { chatId: CHAT, sourceMessageId: ID, file: FILE_SCHEMA, idempotencyKey: KEY }, required: ["chatId", "sourceMessageId", "file", "idempotencyKey"], write: true },
};

export const META_TOOLS = ["instagram", "facebook"].flatMap((platform) => Object.entries(OPERATIONS).map(([operation, spec]) => ({
  name: `${platform}_${operation}`,
  title: `${platform === "instagram" ? "Instagram" : "Facebook 粉專"} ${spec.title}`,
  description: spec.write
    ? "只回覆已收到的同一私人對話訊息；須提供 sourceMessageId 及冪等鍵，保留平台回覆窗口、暫停、生效時間及 Auto-review。身份僅按橋接器 permission 判定；L5 只使用公開安全資料。"
    : "讀取此平台已授權帳戶的橋接資料。permission 為伺服器按 ID 重算的規則層；不代表原生 Dot 記憶已硬隔離。",
  inputSchema: { type: "object", properties: spec.properties, required: spec.required, additionalProperties: false },
  annotations: { readOnlyHint: !spec.write, destructiveHint: false, openWorldHint: Boolean(spec.write), idempotentHint: true },
  securitySchemes: [{ type: "oauth2", scopes: [`${platform}.${spec.write ? "send" : "read"}`] }],
})));

export function metaToolScope(name) {
  const tool = META_TOOLS.find((item) => item.name === name);
  return tool?.securitySchemes[0].scopes[0] ?? null;
}

function invalid() { return Object.assign(new Error("Invalid Meta tool arguments"), { rpcCode: -32602 }); }
function text(value, maximum, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw invalid();
  return value;
}
function limit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw invalid();
  return value;
}
function file(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !Object.hasOwn(FILE_SCHEMA.properties, key))) throw invalid();
  const result = { download_url: text(value.download_url, 4096), file_id: text(value.file_id, 512) };
  if (value.mime_type !== undefined) result.mime_type = text(value.mime_type, 256);
  if (value.file_name !== undefined) result.file_name = text(value.file_name, 255);
  return result;
}
function result(value) {
  const structuredContent = value && typeof value === "object" ? value : { result: value };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}
function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  throw invalid();
}

export async function callMetaTool({ name, args, bridge, media, mediaDownloader }) {
  const platform = name.startsWith("instagram_") ? "instagram" : name.startsWith("facebook_") ? "facebook" : null;
  const operation = platform ? name.slice(platform.length + 1) : null;
  const spec = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null;
  if (!spec || !args || typeof args !== "object" || Array.isArray(args)) throw invalid();
  if (Object.keys(args).some((key) => !Object.hasOwn(spec.properties, key)) || spec.required.some((key) => args[key] === undefined)) throw invalid();
  const values = { platform };
  if (args.chatId !== undefined) values.chatId = text(args.chatId, 160);
  if (args.sourceMessageId !== undefined) values.sourceMessageId = text(args.sourceMessageId, 500);
  if (args.idempotencyKey !== undefined) values.idempotencyKey = text(args.idempotencyKey, 128, 8);
  switch (operation) {
    case "status": return result(bridge.getStatus(platform));
    case "list_chats": return result(bridge.listChats({ ...values, limit: limit(args.limit, 50, 50) }));
    case "get_messages": return result(bridge.getMessages({ ...values, limit: limit(args.limit, 30, 100) }));
    case "get_pending_replies": {
      if (!Number.isSafeInteger(args.after) || args.after < 1) throw invalid();
      return result(bridge.getPendingReplies({ ...values, after: args.after, limit: limit(args.limit, 20, 20) }));
    }
    case "send_text": return result(await bridge.sendText({ ...values, text: text(args.text, 2000) }));
    case "send_image": {
      const uploaded = await mediaDownloader(file(args.file), { maximum: MAX_IMAGE_BYTES });
      if (!Buffer.isBuffer(uploaded.data) || uploaded.data.length < 1 || uploaded.data.length > MAX_IMAGE_BYTES) throw invalid();
      const mimetype = imageType(uploaded.data);
      const attachment = media.put({ data: uploaded.data, mimetype, fileName: uploaded.fileName || "image" });
      return result(await bridge.sendImage({ ...values, imageUrl: attachment.downloadUrl, imageDigest: createHash("sha256").update(uploaded.data).digest("hex") }));
    }
    case "get_media": {
      const descriptor = bridge.getMediaDescriptor({ ...values, messageId: text(args.messageId, 500) });
      if (!descriptor) throw Object.assign(new Error("Media unavailable"), { status: 404 });
      const { mediaType, ...download } = descriptor;
      const uploaded = await mediaDownloader(download, { maximum: mediaType === "image" ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES });
      if (!Buffer.isBuffer(uploaded.data) || uploaded.data.length < 1 || uploaded.data.length > MAX_MEDIA_BYTES) throw invalid();
      const attachment = media.put({ data: uploaded.data, mimetype: uploaded.mimetype, fileName: uploaded.fileName });
      const content = [{ type: "resource_link", uri: attachment.downloadUrl, name: attachment.fileName, mimeType: attachment.mimetype, size: attachment.size }];
      if (descriptor.mediaType === "image") content.unshift({ type: "image", data: uploaded.data.toString("base64"), mimeType: imageType(uploaded.data) });
      return { content, structuredContent: attachment, isError: false };
    }
    default: throw invalid();
  }
}
