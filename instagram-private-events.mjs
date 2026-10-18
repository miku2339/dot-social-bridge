import { createHash } from "node:crypto";
import { EventSubscriptions, EventsError } from "./events.mjs";

const NUMERIC = /^[0-9]{1,64}$/;
const LEVELS = new Set(["L1", "L2", "L3", "L4", "L5"]);
const EVENT_NAMES = {
  dm: "instagram.private_message_received",
  group: "instagram.group_message_received",
};

export class InstagramPrivateEvents {
  constructor(options) {
    this.providers = Object.fromEntries(Object.keys(EVENT_NAMES).map((kind) => [kind,
      new EventSubscriptions({ ...options, adapter: adapter(kind) }),
    ]));
  }

  list(params = {}) {
    return { events: Object.values(this.providers).flatMap((provider) => provider.list(params).events) };
  }

  subscribe(params, principal) { return this.#provider(params?.name).subscribe(params, principal); }
  unsubscribe(params, principal) { return this.#provider(params?.name).unsubscribe(params, principal); }
  async start() { await Promise.all(Object.values(this.providers).map((provider) => provider.start())); }
  async stop() {
    const results = await Promise.allSettled(Object.values(this.providers).map((provider) => provider.stop()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  publish(message) {
    if (typeof message?.isGroup !== "boolean") throw invalid();
    return this.providers[message.isGroup ? "group" : "dm"].publish(message);
  }
  #provider(name) {
    const kind = Object.keys(EVENT_NAMES).find((value) => EVENT_NAMES[value] === name);
    if (!kind) throw new EventsError(-32023, "NotFound", { kind: "event" });
    return this.providers[kind];
  }
}

function adapter(kind) {
  return {
    name: EVENT_NAMES[kind],
    stateFileName: `events-instagram-private-${kind}-state.json`,
    definition: definition(kind),
    validateArguments: (args) => argumentsFor(args, kind),
    isStoredArguments: (args) => {
      try { return JSON.stringify(argumentsFor(args, kind)) === JSON.stringify(args); } catch { return false; }
    },
    normalizeMessage: (message) => normalize(message, kind),
    normalizeStoredMessage: (message) => normalize(message, kind, true),
    matchesMessage: (subscription, message) => subscription.arguments.accountId === message.accountId
      && (!subscription.arguments.chatIds || subscription.arguments.chatIds.includes(message.chatId)),
    eventId: (message) => `evt_igprivate_${createHash("sha256").update(JSON.stringify([
      message.accountId, message.chatId, message.id,
    ])).digest("base64url").slice(0, 32)}`,
  };
}

function definition(kind) {
  const id = { type: "string", pattern: "^[0-9]{1,64}$", maxLength: 64 };
  const chat = { type: "string", pattern: `^instagram_private:[0-9]{1,64}:${kind}:[0-9]{1,64}$`, maxLength: 180 };
  return {
    name: EVENT_NAMES[kind],
    description: kind === "group"
      ? "New instagrapi group message with current Bot, sender and verified owner membership. Group data is public-safe only."
      : "New instagrapi direct message approved by this independent private-session bridge.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object", properties: {
        accountId: id,
        chatIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: chat },
      }, required: ["accountId"], additionalProperties: false,
    },
    payloadSchema: {
      type: "object", properties: {
        platform: { const: "instagram_private" }, accountId: id, chatId: chat,
        id: { type: "string", minLength: 1, maxLength: 512 }, senderId: id,
        text: { type: ["string", "null"], maxLength: 65_536 },
        timestamp: { type: "string", format: "date-time" },
        fromMe: { const: false }, isGroup: { const: kind === "group" },
        type: { type: "string", enum: ["text", "media"] }, replyAllowed: { const: true },
        mediaType: { type: ["string", "null"], maxLength: 32 },
        media: { type: "object", properties: {
          mimetype: { type: ["string", "null"], maxLength: 512 },
          fileName: { type: ["string", "null"], maxLength: 1024 },
        }, required: ["mimetype", "fileName"], additionalProperties: false },
        permission: { type: "object", properties: {
          mode: { const: "rules_only" },
          actorLevel: { type: "string", enum: [...LEVELS] },
          roomLevel: { type: "string", enum: [...LEVELS] },
          effectiveLevel: { type: "string", enum: [...LEVELS] },
          audience: { const: kind === "group" ? "group" : "private" },
          actorIsOwner: { type: "boolean" }, policyValid: { const: true },
          privateDataAllowed: { type: "boolean" }, managePermissionsAllowed: { type: "boolean" },
        }, required: ["mode", "actorLevel", "roomLevel", "effectiveLevel", "audience", "actorIsOwner", "policyValid", "privateDataAllowed", "managePermissionsAllowed"], additionalProperties: false },
      }, required: ["platform", "accountId", "chatId", "id", "senderId", "text", "timestamp", "fromMe", "isGroup", "type", "replyAllowed", "permission"], additionalProperties: false,
    },
  };
}

function argumentsFor(value, kind) {
  if (!record(value) || Object.keys(value).some((key) => !["accountId", "chatIds"].includes(key)) || !numeric(value.accountId)) throw invalid();
  const result = { accountId: value.accountId };
  if (value.chatIds !== undefined) {
    if (!Array.isArray(value.chatIds) || value.chatIds.length < 1 || value.chatIds.length > 20
      || new Set(value.chatIds).size !== value.chatIds.length
      || value.chatIds.some((chatId) => !validChat(chatId, value.accountId, kind))) throw invalid();
    result.chatIds = [...value.chatIds].sort();
  }
  return result;
}

function normalize(value, kind, stored = false) {
  if (!record(value)) throw invalid();
  if (value.fromMe === true || value.replyAllowed === false) return null;
  if (value.platform !== "instagram_private" || value.isGroup !== (kind === "group")) return null;
  if (value.fromMe !== false || value.replyAllowed !== true || !numeric(value.accountId) || !numeric(value.senderId)
    || !validChat(value.chatId, value.accountId, kind)) throw invalid();
  if (!["text", "media"].includes(value.type)) return null;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 512 || /[\u0000-\u001f\u007f]/.test(value.id)
    || (value.text !== null && (typeof value.text !== "string" || value.text.length > 65_536))) throw invalid();
  if (!(Number.isSafeInteger(value.timestamp) && value.timestamp >= 0)
    && !(stored && typeof value.timestamp === "string")) throw invalid();
  const date = new Date(value.timestamp);
  if (!Number.isFinite(date.getTime())) throw invalid();
  const permission = value.permission;
  if (!record(permission) || permission.mode !== "rules_only" || permission.policyValid !== true
    || permission.audience !== (kind === "group" ? "group" : "private")
    || ![permission.actorLevel, permission.roomLevel, permission.effectiveLevel].every((level) => LEVELS.has(level))
    || !["actorIsOwner", "privateDataAllowed", "managePermissionsAllowed"].every((field) => typeof permission[field] === "boolean")) throw invalid();
  if ((permission.privateDataAllowed || permission.managePermissionsAllowed)
    && (kind === "group" || !permission.actorIsOwner || permission.effectiveLevel !== "L1")) throw invalid();
  const safePermission = Object.fromEntries(["mode", "actorLevel", "roomLevel", "effectiveLevel", "audience", "actorIsOwner", "policyValid", "privateDataAllowed", "managePermissionsAllowed"].map((key) => [key, permission[key]]));
  const result = {
    platform: "instagram_private", accountId: value.accountId, chatId: value.chatId,
    id: value.id, senderId: value.senderId, text: value.text, timestamp: date.toISOString(),
    fromMe: false, isGroup: value.isGroup, type: value.type, replyAllowed: true, permission: safePermission,
  };
  if (value.mediaType !== undefined) result.mediaType = nullableText(value.mediaType, 32);
  if (value.media !== undefined) {
    if (!record(value.media)) throw invalid();
    result.media = { mimetype: nullableText(value.media.mimetype, 512), fileName: nullableText(value.media.fileName, 1024) };
  }
  return result;
}

function validChat(value, accountId, kind) {
  return typeof value === "string" && value.length <= 180
    && new RegExp(`^instagram_private:${accountId}:${kind}:[0-9]{1,64}$`).test(value);
}
function nullableText(value, maximum) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum) throw invalid();
  return value;
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function numeric(value) { return typeof value === "string" && NUMERIC.test(value); }
function invalid() { return new EventsError(-32602, "InvalidParams"); }
