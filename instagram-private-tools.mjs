import { MAX_IMAGE_BYTES, MAX_MEDIA_BYTES } from "./media.mjs";

const CHAT = { type: "string", minLength: 1, maxLength: 180 };
const ID = { type: "string", minLength: 1, maxLength: 512 };
const FILE = { type: "object", properties: {
  download_url: { type: "string" }, file_id: { type: "string" },
  mime_type: { type: "string" }, file_name: { type: "string" },
}, required: ["download_url", "file_id"], additionalProperties: false };
const SEND = { chatId: CHAT, sourceMessageId: ID, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } };
const SPECS = {
  status: { properties: {}, required: [] },
  list_chats: { properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, scope: { type: "string", enum: ["all", "private", "groups"] } }, required: [] },
  get_messages: { properties: { chatId: CHAT, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["chatId"] },
  get_group_info: { properties: { chatId: CHAT }, required: ["chatId"] },
  get_pending_replies: { properties: { after: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["after"] },
  get_media: { properties: { chatId: CHAT, messageId: ID }, required: ["chatId", "messageId"] },
  send_text: { properties: { ...SEND, text: { type: "string", minLength: 1, maxLength: 2000 } }, required: [...Object.keys(SEND), "text"], write: true },
  send_image: { properties: { ...SEND, file: FILE }, required: [...Object.keys(SEND), "file"], write: true },
};

export const INSTAGRAM_PRIVATE_TOOLS = Object.entries(SPECS).map(([operation, spec]) => ({
  name: `instagram_private_${operation}`,
  title: `Instagram instagrapi ${operation}`,
  description: spec.write
    ? "回覆 instagrapi 來源的同一私訊或群組，必須指定 sourceMessageId。文字與圖片共用來源防重，結果不明不可換 key 重試。群組只使用同群及公開資料；保留 Auto-review。"
    : "讀取獨立 instagrapi session 的資料；私人 numeric ID／thread ID 不可與官方 IGSID 混用。permission 只屬規則層，未驗證原生 Dot 記憶硬隔離。",
  inputSchema: { type: "object", properties: spec.properties, required: spec.required, additionalProperties: false },
  annotations: { readOnlyHint: !spec.write, destructiveHint: false, openWorldHint: Boolean(spec.write), idempotentHint: true },
  securitySchemes: [{ type: "oauth2", scopes: [`instagram.private.${spec.write ? "send" : "read"}`] }],
}));

export function instagramPrivateToolScope(name) {
  return INSTAGRAM_PRIVATE_TOOLS.find((tool) => tool.name === name)?.securitySchemes[0].scopes[0] ?? null;
}

export async function callInstagramPrivateTool({ name, args, bridge, media, mediaDownloader }) {
  const operation = typeof name === "string" ? name.slice("instagram_private_".length) : "";
  const spec = Object.hasOwn(SPECS, operation) ? SPECS[operation] : null;
  if (typeof name !== "string" || !name.startsWith("instagram_private_") || !spec || !args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !Object.hasOwn(spec.properties, key)) || spec.required.some((key) => args[key] === undefined)) throw invalid();
  const values = {};
  for (const key of ["chatId", "sourceMessageId", "messageId", "idempotencyKey"]) {
    if (args[key] !== undefined) values[key] = string(args[key], spec.properties[key].maxLength, spec.properties[key].minLength || 1);
  }
  switch (operation) {
    case "status": return result(await bridge.getStatus());
    case "list_chats": {
      if (args.scope !== undefined && !["all", "private", "groups"].includes(args.scope)) throw invalid();
      return result(await bridge.listChats({ scope: args.scope || "all", limit: integer(args.limit, 50, 50) }));
    }
    case "get_messages": return result(await bridge.getMessages({ ...values, limit: integer(args.limit, 30, 100) }));
    case "get_group_info": return result(await bridge.getGroupInfo(values));
    case "get_pending_replies": {
      if (!Number.isSafeInteger(args.after) || args.after < 1) throw invalid();
      return result(await bridge.getPendingReplies({ after: args.after, limit: integer(args.limit, 20, 20) }));
    }
    case "send_text": return result(await bridge.sendText({ ...values, text: string(args.text, 2000) }));
    case "send_image": {
      const upload = await mediaDownloader(file(args.file), { maximum: MAX_IMAGE_BYTES });
      if (!Buffer.isBuffer(upload.data) || upload.data.length < 1 || upload.data.length > MAX_IMAGE_BYTES) throw invalid();
      const mimetype = imageType(upload.data);
      return result(await bridge.sendImage({ ...values, data: upload.data, mimetype, fileName: upload.fileName }));
    }
    case "get_media": {
      const descriptor = await bridge.getMediaDescriptor(values);
      if (!descriptor) throw unavailable();
      const upload = await mediaDownloader({
        download_url: descriptor.url,
        file_id: values.messageId,
        ...(descriptor.mimetype ? { mime_type: descriptor.mimetype } : {}),
        ...(descriptor.fileName ? { file_name: descriptor.fileName } : {}),
      }, { maximum: descriptor.mediaType === "image" ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES });
      if (!Buffer.isBuffer(upload.data) || upload.data.length < 1 || upload.data.length > (descriptor.mediaType === "image" ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES)) throw invalid();
      if (!await bridge.getMediaDescriptor(values)) throw unavailable();
      const mimetype = descriptor.mediaType === "image" ? imageType(upload.data) : upload.mimetype;
      const attachment = media.put({ data: upload.data, mimetype, fileName: upload.fileName });
      const content = [{ type: "resource_link", uri: attachment.downloadUrl, name: attachment.fileName, mimeType: attachment.mimetype, size: attachment.size }];
      if (descriptor.mediaType === "image") content.unshift({ type: "image", data: upload.data.toString("base64"), mimeType: mimetype });
      return { content, structuredContent: attachment, isError: false };
    }
    default: throw invalid();
  }
}

function result(value) {
  const structuredContent = value && typeof value === "object" ? value : { result: value };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
}
function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw invalid();
  return value;
}
function string(value, maximum, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw invalid();
  return value;
}
function file(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !Object.hasOwn(FILE.properties, key))) throw invalid();
  return { download_url: string(value.download_url, 4096), file_id: string(value.file_id, 512),
    ...(value.mime_type === undefined ? {} : { mime_type: string(value.mime_type, 256) }),
    ...(value.file_name === undefined ? {} : { file_name: string(value.file_name, 255) }),
  };
}
function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  throw invalid();
}
function invalid() { return Object.assign(new Error("Invalid instagrapi arguments"), { rpcCode: -32602 }); }
function unavailable() { return Object.assign(new Error("Media unavailable"), { status: 403 }); }
