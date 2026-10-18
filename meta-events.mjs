import { createHash } from "node:crypto";

import { EventSubscriptions, EventsError } from "./events.mjs";

const PLATFORMS = new Set(["instagram", "facebook"]);
const LEVELS = new Set(["L1", "L2", "L3", "L4", "L5"]);
const MAX_CHAT_IDS = 20;

export class MetaEventSubscriptions extends EventSubscriptions {
  constructor({ platform, ...options } = {}) {
    super({ ...options, adapter: createMetaEventAdapter(platform) });
    this.platform = platform;
  }
}

export class SocialEventRouter {
  constructor({ whatsapp, instagram, facebook, instagramPrivate } = {}) {
    this.providers = { whatsapp, instagram, facebook, instagramPrivate };
  }

  list(params = {}, principal) {
    const identity = validateRouterPrincipal(principal);
    validateListParams(params);
    const events = [];
    for (const [platform, scope] of [["whatsapp", "whatsapp.read"], ["instagram", "instagram.read"], ["facebook", "facebook.read"], ["instagramPrivate", "instagram.private.read"]]) {
      if (!identity.scopes.has(scope)) continue;
      const provider = this.providers[platform];
      if (provider) events.push(...provider.list(params).events);
    }
    return { events };
  }

  subscribe(params, principal) {
    const { provider, identity } = this.#authorizedProvider(params, principal);
    return provider.subscribe(params, identity.id);
  }

  unsubscribe(params, principal) {
    const { provider, identity } = this.#authorizedProvider(params, principal);
    return provider.unsubscribe(params, identity.id);
  }

  async start() {
    await Promise.all(Object.values(this.providers).filter(Boolean).map((provider) => provider.start()));
  }

  async stop() {
    const results = await Promise.allSettled(
      Object.values(this.providers).filter(Boolean).map((provider) => provider.stop()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  publishMeta(message) {
    const platform = message?.platform;
    if (!PLATFORMS.has(platform)) throw invalidParams("Invalid Meta message platform");
    const provider = this.providers[platform];
    if (!provider) throw notFound();
    return provider.publish(message);
  }

  publishInstagramPrivate(message) {
    if (!this.providers.instagramPrivate) throw notFound();
    return this.providers.instagramPrivate.publish(message);
  }

  #authorizedProvider(params, principal) {
    const identity = validateRouterPrincipal(principal);
    const scope = eventReadScope(params?.name);
    if (!scope) throw notFound();
    if (!identity.scopes.has(scope)) throw new EventsError(-32024, "Forbidden");
    const provider = this.providers[scope === "instagram.private.read" ? "instagramPrivate" : scope.slice(0, scope.indexOf("."))];
    if (!provider) throw notFound();
    return { provider, identity };
  }
}

export function eventReadScope(name) {
  if (name === "whatsapp.message_received") return "whatsapp.read";
  if (name === "instagram.message_received") return "instagram.read";
  if (name === "facebook.message_received") return "facebook.read";
  if (name === "instagram.private_message_received" || name === "instagram.group_message_received") return "instagram.private.read";
  return null;
}

function createMetaEventAdapter(platform) {
  if (!PLATFORMS.has(platform)) throw new TypeError("platform must be instagram or facebook");
  return Object.freeze({
    name: `${platform}.message_received`,
    stateFileName: `events-${platform}-state.json`,
    definition: metaEventDefinition(platform),
    validateArguments: (value) => validateMetaArguments(value, platform),
    isStoredArguments: (value) => isStoredMetaArguments(value, platform),
    normalizeMessage: (value) => normalizeMetaMessage(value, platform),
    normalizeStoredMessage: (value) => normalizeMetaMessage(value, platform, { stored: true }),
    matchesMessage: metaSubscriptionMatchesMessage,
    eventId: metaEventId,
  });
}

function metaEventDefinition(platform) {
  const numericId = { type: "string", pattern: "^[0-9]{1,64}$", maxLength: 64 };
  const level = { type: "string", enum: [...LEVELS] };
  return {
    name: `${platform}.message_received`,
    description: `A new incoming ${platform === "instagram" ? "Instagram" : "Facebook"} private message approved for reply by the bridge.`,
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        accountId: numericId,
        chatIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CHAT_IDS,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: `^${platform}:[0-9]{1,64}:[0-9]{1,64}$`,
            maxLength: 160,
          },
        },
      },
      anyOf: [{ required: ["accountId"] }, { required: ["chatIds"] }],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        platform: { const: platform },
        accountId: numericId,
        chatId: {
          type: "string",
          pattern: `^${platform}:[0-9]{1,64}:[0-9]{1,64}$`,
          maxLength: 160,
        },
        id: { type: "string", minLength: 1, maxLength: 512 },
        senderId: numericId,
        text: { type: ["string", "null"], maxLength: 65_536 },
        timestamp: { type: "string", format: "date-time" },
        fromMe: { const: false },
        type: { type: "string", enum: ["text", "media"] },
        mediaType: { type: "string", minLength: 1, maxLength: 32 },
        media: {
          type: "object",
          properties: {
            mimetype: { type: ["string", "null"], maxLength: 512 },
            fileName: { type: ["string", "null"], maxLength: 1_024 },
          },
          required: ["mimetype", "fileName"],
          additionalProperties: false,
        },
        permission: {
          type: "object",
          properties: {
            mode: { const: "rules_only" },
            actorLevel: level,
            roomLevel: level,
            effectiveLevel: level,
            audience: { const: "private" },
            actorIsOwner: { type: "boolean" },
            policyValid: { const: true },
            privateDataAllowed: { type: "boolean" },
            managePermissionsAllowed: { type: "boolean" },
          },
          required: ["mode", "actorLevel", "roomLevel", "effectiveLevel", "audience", "actorIsOwner", "policyValid", "privateDataAllowed", "managePermissionsAllowed"],
          additionalProperties: false,
        },
        replyAllowed: { const: true },
      },
      required: ["platform", "accountId", "chatId", "id", "senderId", "text", "timestamp", "fromMe", "type", "permission", "replyAllowed"],
      additionalProperties: false,
    },
  };
}

function validateMetaArguments(value, platform) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["accountId", "chatIds"].includes(key))) {
    throw invalidParams("arguments may contain only accountId and chatIds");
  }
  const accountId = value.accountId === undefined ? null : validateNumericId(value.accountId, "accountId");
  let chatIds = null;
  if (value.chatIds !== undefined) {
    if (!Array.isArray(value.chatIds) || value.chatIds.length === 0 || value.chatIds.length > MAX_CHAT_IDS) {
      throw invalidParams(`chatIds must contain between 1 and ${MAX_CHAT_IDS} IDs`);
    }
    chatIds = [...new Set(value.chatIds)];
    const tuples = chatIds.map((chatId) => parseMetaChatId(chatId, platform));
    if (chatIds.length !== value.chatIds.length || tuples.some((tuple) => tuple === null)) {
      throw invalidParams(`chatIds must be unique, exact ${platform} IDs`);
    }
    if (accountId && tuples.some((tuple) => tuple.accountId !== accountId)) {
      throw invalidParams("chatIds must match accountId");
    }
  }
  if (!accountId && !chatIds) throw invalidParams("Provide accountId or non-empty chatIds");
  return {
    ...(accountId ? { accountId } : {}),
    ...(chatIds ? { chatIds: chatIds.sort() } : {}),
  };
}

function isStoredMetaArguments(value, platform) {
  try {
    const normalized = validateMetaArguments(value, platform);
    return JSON.stringify(normalized) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function normalizeMetaMessage(value, platform, { stored = false } = {}) {
  if (!isRecord(value)) throw invalidParams("Invalid normalized Meta message");
  if (["history", "history_sync", "status", "protocol", "notification"].includes(String(value.type).toLowerCase())) return null;
  if (value.fromMe === true) return null;
  if (value.fromMe !== false) throw invalidParams("Invalid message fromMe");
  if (value.platform !== platform || value.replyAllowed !== true) return null;

  const accountId = validateNumericId(value.accountId, "accountId");
  const senderId = validateNumericId(value.senderId, "senderId");
  const tuple = parseMetaChatId(value.chatId, platform);
  if (!tuple || tuple.accountId !== accountId || tuple.senderId !== senderId) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 512 || /[\u0000-\u001f\u007f]/.test(value.id)) {
    throw invalidParams("Invalid message id");
  }
  if (value.text !== null && (typeof value.text !== "string" || value.text.length > 65_536)) {
    throw invalidParams("Invalid message text");
  }
  if (value.type !== "text" && value.type !== "media") throw invalidParams("Invalid message type");
  const validTimestamp = Number.isSafeInteger(value.timestamp) && value.timestamp >= 0;
  const validStoredTimestamp = stored && typeof value.timestamp === "string";
  if (!validTimestamp && !validStoredTimestamp) throw invalidParams("Invalid message timestamp");
  const date = new Date(value.timestamp);
  if (!Number.isFinite(date.getTime())) throw invalidParams("Invalid message timestamp");

  const message = {
    platform,
    accountId,
    chatId: value.chatId,
    id: value.id,
    senderId,
    text: value.text,
    timestamp: date.toISOString(),
    fromMe: false,
    type: value.type,
    permission: normalizePermission(value.permission),
    replyAllowed: true,
  };
  if (value.mediaType !== undefined) {
    if (typeof value.mediaType !== "string" || value.mediaType.length === 0 || value.mediaType.length > 32) {
      throw invalidParams("Invalid message mediaType");
    }
    message.mediaType = value.mediaType;
  }
  if (value.media !== undefined) {
    if (!isRecord(value.media)) throw invalidParams("Invalid message media");
    const mimetype = nullableBoundedString(value.media.mimetype, 512, "media mimetype");
    const fileName = nullableBoundedString(value.media.fileName, 1_024, "media fileName");
    message.media = { mimetype, fileName };
  }
  return message;
}

function normalizePermission(value) {
  if (!isRecord(value) || value.mode !== "rules_only" || value.audience !== "private" || value.policyValid !== true) {
    throw invalidParams("Invalid message permission");
  }
  for (const field of ["actorLevel", "roomLevel", "effectiveLevel"]) {
    if (!LEVELS.has(value[field])) throw invalidParams("Invalid message permission");
  }
  for (const field of ["actorIsOwner", "privateDataAllowed", "managePermissionsAllowed"]) {
    if (typeof value[field] !== "boolean") throw invalidParams("Invalid message permission");
  }
  if ((value.privateDataAllowed || value.managePermissionsAllowed) && (!value.actorIsOwner || value.effectiveLevel !== "L1")) {
    throw invalidParams("Invalid privileged message permission");
  }
  return {
    mode: "rules_only",
    actorLevel: value.actorLevel,
    roomLevel: value.roomLevel,
    effectiveLevel: value.effectiveLevel,
    audience: "private",
    actorIsOwner: value.actorIsOwner,
    policyValid: true,
    privateDataAllowed: value.privateDataAllowed,
    managePermissionsAllowed: value.managePermissionsAllowed,
  };
}

function metaSubscriptionMatchesMessage(subscription, message) {
  return (subscription.arguments.accountId === undefined || subscription.arguments.accountId === message.accountId) &&
    (subscription.arguments.chatIds === undefined || subscription.arguments.chatIds.includes(message.chatId));
}

function metaEventId(message) {
  const digest = createHash("sha256")
    .update(message.platform)
    .update("\0")
    .update(message.accountId)
    .update("\0")
    .update(message.chatId)
    .update("\0")
    .update(message.id)
    .digest("base64url");
  return `evt_${message.platform}_${digest.slice(0, 32)}`;
}

function parseMetaChatId(value, platform) {
  if (typeof value !== "string" || value.length > 160) return null;
  const match = new RegExp(`^${platform}:([0-9]{1,64}):([0-9]{1,64})$`).exec(value);
  return match ? { accountId: match[1], senderId: match[2] } : null;
}

function validateNumericId(value, field) {
  if (typeof value !== "string" || !/^[0-9]{1,64}$/.test(value)) throw invalidParams(`Invalid ${field}`);
  return value;
}

function nullableBoundedString(value, maxLength, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) throw invalidParams(`Invalid ${field}`);
  return value;
}

function validateRouterPrincipal(principal) {
  if (!isRecord(principal) || typeof principal.id !== "string" || principal.id.length === 0 || principal.id.length > 512 || !Array.isArray(principal.scopes)) {
    throw new EventsError(-32024, "Forbidden");
  }
  return { id: principal.id, scopes: new Set(principal.scopes.filter((scope) => typeof scope === "string")) };
}

function validateListParams(params) {
  if (!isRecord(params)) throw invalidParams("events/list params must be an object");
  if (params.cursor !== undefined && params.cursor !== null) throw invalidParams("events/list does not have another page");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidParams(reason) {
  return new EventsError(-32602, "InvalidParams", { reason });
}

function notFound() {
  return new EventsError(-32023, "NotFound", { kind: "event" });
}
