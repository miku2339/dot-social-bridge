import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { InstagramWorkerClient } from './instagram-worker-client.mjs'

const STATE_VERSION = 1
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_MESSAGES = 500
const MAX_RECEIPTS = 500
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 5 * 60 * 1000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ID = /^[1-9]\d{0,63}$/
const LEVELS = new Set(['L2', 'L3', 'L4', 'L5'])
const CONNECTION_STATUSES = new Set(['not_configured', 'connected', 'login_required', 'challenge_required', 'rate_limited', 'error'])
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function bridgeError(message, status = 400, code = 'EINSTAGRAMPRIVATE') {
  return Object.assign(new Error(message), { status, statusCode: status, code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => !RESERVED_KEYS.has(key) && allowed.has(key))
}

function cleanId(value, name = 'ID') {
  if (typeof value !== 'string' || !ID.test(value)) throw bridgeError(`${name} is invalid`)
  return value
}

function cleanMessageId(value, name = 'Message ID') {
  return cleanString(value, name, 512)
}

function cleanString(value, name, maximum, { optional = false, allowEmpty = false } = {}) {
  if ((value === undefined || value === null) && optional) return null
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw bridgeError(`${name} is invalid`)
  }
  return value
}

function safeLabel(value, maximum) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value || null
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    settings: { expectedAccountId: null },
    channel: {
      status: 'not_configured',
      account: null,
      autoReplyEnabled: false,
      groupRepliesEnabled: false,
      cutoff: null,
      lastError: null
    },
    users: [],
    groups: [],
    messages: [],
    dedupe: [],
    receipts: []
  }
}

function validAccount(value) {
  return hasOnlyKeys(value, new Set(['id', 'username'])) && ID.test(value.id)
    && typeof value.username === 'string' && value.username.length > 0 && value.username.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value.username)
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  } catch { return false }
}

function validStoredMessage(value) {
  return hasOnlyKeys(value, new Set([
    'accountId', 'chatId', 'threadId', 'id', 'senderId', 'text', 'timestamp', 'storedAt', 'fromMe', 'type',
    'isGroup', 'title', 'mediaType', 'media', 'descriptor', 'replyToMessageId'
  ]))
    && ID.test(value.accountId) && validChatId(value.chatId, value.accountId, value.threadId, value.isGroup)
    && ID.test(value.threadId) && validMessageId(value.id) && ID.test(value.senderId)
    && (value.text === null || (typeof value.text === 'string' && value.text.length <= 4000))
    && Number.isSafeInteger(value.timestamp) && value.timestamp >= 0
    && Number.isSafeInteger(value.storedAt) && value.storedAt >= 0
    && value.fromMe === false && ['text', 'media'].includes(value.type) && typeof value.isGroup === 'boolean'
    && (value.title === null || (typeof value.title === 'string' && value.title.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.title)))
    && (value.mediaType === null || (typeof value.mediaType === 'string' && value.mediaType.length <= 50))
    && (value.media === null || (hasOnlyKeys(value.media, new Set(['mimetype', 'fileName']))
      && (value.media.mimetype === null || (typeof value.media.mimetype === 'string' && value.media.mimetype.length <= 200))
      && (value.media.fileName === null || (typeof value.media.fileName === 'string' && value.media.fileName.length <= 255))))
    && (value.descriptor === null || (hasOnlyKeys(value.descriptor, new Set(['url', 'mimetype', 'fileName', 'mediaType']))
      && validHttpsUrl(value.descriptor.url)
      && (value.descriptor.mimetype === null || (typeof value.descriptor.mimetype === 'string' && value.descriptor.mimetype.length <= 200))
      && (value.descriptor.fileName === null || (typeof value.descriptor.fileName === 'string' && value.descriptor.fileName.length <= 255))
      && typeof value.descriptor.mediaType === 'string' && value.descriptor.mediaType.length <= 50))
    && (value.replyToMessageId === null || validMessageId(value.replyToMessageId))
}

function validChatId(value, accountId, threadId, isGroup) {
  return value === `instagram_private:${accountId}:${isGroup ? 'group' : 'dm'}:${threadId}`
}

function validMessageId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
}

function validReceiptChat(value, accountId) {
  const match = typeof value === 'string' ? /^instagram_private:(\d{1,64}):(dm|group):(\d{1,64})$/.exec(value) : null
  return Boolean(match && match[1] === accountId && ID.test(match[1]) && ID.test(match[3]))
}

function validState(state) {
  if (!hasOnlyKeys(state, new Set(['version', 'revision', 'settings', 'channel', 'users', 'groups', 'messages', 'dedupe', 'receipts']))) return false
  if (state.version !== STATE_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0) return false
  if (!hasOnlyKeys(state.settings, new Set(['expectedAccountId']))
    || (state.settings.expectedAccountId !== null && !ID.test(state.settings.expectedAccountId))) return false
  const channel = state.channel
  if (!hasOnlyKeys(channel, new Set(['status', 'account', 'autoReplyEnabled', 'groupRepliesEnabled', 'cutoff', 'lastError']))
    || !CONNECTION_STATUSES.has(channel.status)
    || (channel.account !== null && !validAccount(channel.account))
    || typeof channel.autoReplyEnabled !== 'boolean' || typeof channel.groupRepliesEnabled !== 'boolean'
    || (channel.cutoff !== null && (!Number.isSafeInteger(channel.cutoff) || channel.cutoff < 0))
    || (channel.lastError !== null && (typeof channel.lastError !== 'string' || channel.lastError.length > 500))) return false
  if (channel.status === 'connected') {
    if (channel.account === null || channel.account.id !== state.settings.expectedAccountId) return false
  } else if (channel.account !== null || channel.autoReplyEnabled || channel.groupRepliesEnabled) return false
  if (!Array.isArray(state.users) || state.users.length > 1000 || !state.users.every((user) => (
    hasOnlyKeys(user, new Set(['accountId', 'senderId', 'displayName', 'level', 'ownerId']))
    && ID.test(user.accountId) && ID.test(user.senderId)
    && typeof user.displayName === 'string' && user.displayName.length > 0 && user.displayName.length <= 100
    && !/[\u0000-\u001f\u007f]/.test(user.displayName)
    && LEVELS.has(user.level)
    && (user.ownerId === null || (typeof user.ownerId === 'string' && user.ownerId.length > 0 && user.ownerId.length <= 256))
  )) || !unique(state.users, (user) => `${user.accountId}:${user.senderId}`)) return false
  if (!Array.isArray(state.groups) || state.groups.length > 1000 || !state.groups.every((group) => (
    hasOnlyKeys(group, new Set(['accountId', 'threadId', 'level']))
    && ID.test(group.accountId) && ID.test(group.threadId) && LEVELS.has(group.level)
  )) || !unique(state.groups, (group) => `${group.accountId}:${group.threadId}`)) return false
  if (!Array.isArray(state.messages) || state.messages.length > MAX_MESSAGES || !state.messages.every(validStoredMessage)
    || !unique(state.messages, (message) => `${message.accountId}:${message.chatId}:${message.id}`)) return false
  if (!Array.isArray(state.dedupe) || state.dedupe.length > MAX_MESSAGES || !state.dedupe.every((item) => (
    hasOnlyKeys(item, new Set(['key', 'at'])) && typeof item.key === 'string' && item.key.length <= 700
    && Number.isSafeInteger(item.at) && item.at >= 0
  )) || !unique(state.dedupe, (item) => item.key)) return false
  return Array.isArray(state.receipts) && state.receipts.length <= MAX_RECEIPTS && state.receipts.every((receipt) => (
    hasOnlyKeys(receipt, new Set(['key', 'payloadHash', 'status', 'messageId', 'updatedAt', 'accountId', 'chatId', 'sourceMessageId']))
    && typeof receipt.key === 'string' && receipt.key.length <= 800
    && /^[a-f0-9]{64}$/.test(receipt.payloadHash) && ['unknown', 'sent'].includes(receipt.status)
    && (receipt.messageId === null || validMessageId(receipt.messageId))
    && Number.isSafeInteger(receipt.updatedAt) && receipt.updatedAt >= 0
    && ID.test(receipt.accountId) && validReceiptChat(receipt.chatId, receipt.accountId)
    && validMessageId(receipt.sourceMessageId)
    && receipt.key === `${receipt.accountId}:${receipt.chatId}:${receipt.sourceMessageId}`
  )) && unique(state.receipts, (receipt) => receipt.key)
    && [...state.users, ...state.groups, ...state.messages, ...state.receipts]
      .every((item) => item.accountId === state.settings.expectedAccountId)
}

function unique(values, key) {
  return new Set(values.map(key)).size === values.length
}

function publicAccount(account) {
  return account ? { id: account.id, username: account.username } : null
}

function normalizeWorkerStatus(result) {
  if (!hasOnlyKeys(result, new Set(['status', 'account', 'retryAfter']))) throw bridgeError('Instagram worker status is invalid', 502, 'EPROTOCOL')
  const statuses = new Set(['connected', 'not_configured', 'login_required', 'challenge_required', 'rate_limited', 'provider_error'])
  if (!statuses.has(result.status) || (result.account !== null && !validAccount(result.account))
    || (result.status === 'connected') !== (result.account !== null)
    || (result.retryAfter !== undefined && (!Number.isSafeInteger(result.retryAfter) || result.retryAfter < 1 || result.retryAfter > 86_400))) {
    throw bridgeError('Instagram worker status is invalid', 502, 'EPROTOCOL')
  }
  return result
}

function normalizeMessage(value) {
  if (!hasOnlyKeys(value, new Set(['id', 'senderId', 'text', 'timestamp', 'fromMe', 'mediaType', 'media', 'replyToMessageId']))) return null
  if (!validMessageId(value.id) || !ID.test(value.senderId) || typeof value.fromMe !== 'boolean'
    || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0
    || (value.text !== null && value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 4000))
    || (value.mediaType !== null && value.mediaType !== undefined && (typeof value.mediaType !== 'string' || value.mediaType.length > 50))
    || (value.replyToMessageId !== null && value.replyToMessageId !== undefined && !validMessageId(value.replyToMessageId))) return null
  let media = null
  if (value.media !== undefined && value.media !== null) {
    if (!hasOnlyKeys(value.media, new Set(['url', 'mimetype', 'fileName']))
      || typeof value.media.url !== 'string' || value.media.url.length === 0 || value.media.url.length > 4096) return null
    if (!validHttpsUrl(value.media.url)) return null
    const mimetype = safeLabel(value.media.mimetype, 200)
    const fileName = safeLabel(value.media.fileName, 255)
    media = { url: value.media.url, mimetype, fileName }
  }
  const text = value.text ?? null
  if ((!text || text.length === 0) && !media) return null
  return {
    id: value.id,
    senderId: value.senderId,
    text,
    timestamp: value.timestamp,
    fromMe: value.fromMe,
    mediaType: value.mediaType ?? (media ? 'file' : null),
    media,
    replyToMessageId: value.replyToMessageId ?? null
  }
}

function normalizeThread(value) {
  if (!hasOnlyKeys(value, new Set(['id', 'isGroup', 'title', 'memberIds', 'messages']))
    || !ID.test(value.id) || typeof value.isGroup !== 'boolean'
    || (value.title !== null && value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 200))
    || !Array.isArray(value.memberIds) || value.memberIds.length < 2 || value.memberIds.length > 250
    || !value.memberIds.every((id) => typeof id === 'string' && ID.test(id)) || !unique(value.memberIds, (id) => id)
    || !Array.isArray(value.messages) || value.messages.length > 50) return null
  const messages = value.messages.map(normalizeMessage)
  if (messages.some((message) => message === null)) return null
  return { id: value.id, isGroup: value.isGroup, title: value.title ?? null, memberIds: value.memberIds, messages }
}

export class InstagramPrivateBridge extends EventEmitter {
  constructor({
    dataDir,
    worker = ({ dataDir: workerDataDir, expectedAccountId }) => new InstagramWorkerClient({
      dataDir: workerDataDir,
      expectedAccountId
    }),
    now = Date.now,
    ownerIds = () => [],
    pollIntervalMs = 15_000
  } = {}) {
    super()
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required')
    if ((typeof worker !== 'function' && !isRecord(worker)) || typeof now !== 'function' || typeof ownerIds !== 'function') {
      throw new TypeError('Instagram bridge configuration is invalid')
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > MAX_BACKOFF_MS) {
      throw new TypeError('pollIntervalMs is invalid')
    }
    this.dataDir = dataDir
    this.statePath = join(dataDir, 'instagram-private-state.json')
    this.workerSource = worker
    this.worker = typeof worker === 'function' ? null : worker
    this.now = now
    this.ownerIds = ownerIds
    this.pollIntervalMs = pollIntervalMs
    this.state = defaultState()
    this.valid = true
    this.started = false
    this.messagePublisher = null
    this.mutationChain = Promise.resolve()
    this.sendChain = Promise.resolve()
    this.pollTimer = null
    this.polling = false
    this.backoffMs = pollIntervalMs
  }

  async start() {
    if (this.started) return this.getConsoleState()
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    try {
      this.state = await this.#load()
      this.valid = true
      this.#prune(this.state)
      if (this.state.settings.expectedAccountId !== null) {
        this.state.channel.cutoff = this.now()
        await this.#persist(this.state)
      }
    } catch {
      this.valid = false
      this.state = defaultState()
      this.state.channel.status = 'error'
      this.state.channel.lastError = 'Instagram private state is unavailable'
    }
    this.started = true
    if (this.valid && this.state.settings.expectedAccountId !== null) {
      await this.#refreshConnection().catch(() => {})
      if (this.#connected()) await this.#pollOnce().catch(() => {})
      this.#schedulePoll(this.pollIntervalMs)
    }
    return this.getConsoleState()
  }

  async stop() {
    this.started = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    await this.mutationChain.catch(() => {})
    await this.sendChain.catch(() => {})
    await this.worker?.stop?.().catch(() => {})
    this.worker = typeof this.workerSource === 'function' ? null : this.workerSource
  }

  setMessagePublisher(publisher) {
    if (publisher !== null && typeof publisher !== 'function') throw new TypeError('publisher must be a function or null')
    this.messagePublisher = publisher
  }

  getStatus() {
    return this.#publicChannel()
  }

  getConsoleState() {
    const accountId = this.#connected() ? this.state.channel.account.id : null
    const users = new Map()
    const groups = new Map()
    if (accountId !== null) {
      for (const user of this.state.users.filter((item) => item.accountId === accountId)) {
        users.set(user.senderId, { ...this.#publicUser(user), observedOnly: false })
      }
      for (const message of this.state.messages.filter((item) => item.accountId === accountId)) {
        if (!users.has(message.senderId)) {
          users.set(message.senderId, {
            accountId,
            senderId: message.senderId,
            displayName: message.senderId,
            level: 'L5',
            ownerId: null,
            actorIsOwner: false,
            observedOnly: true
          })
        }
        if (message.isGroup) {
          const existing = groups.get(message.threadId)
          if (!existing || message.timestamp > existing.timestamp) {
            groups.set(message.threadId, { title: message.title, timestamp: message.timestamp })
          }
        }
      }
      for (const group of this.state.groups.filter((item) => item.accountId === accountId)) {
        const observed = groups.get(group.threadId)
        groups.set(group.threadId, { ...observed, level: group.level, saved: true })
      }
    }
    return {
      channel: this.#publicChannel(),
      revision: this.state.revision,
      settings: { expectedAccountId: this.state.settings.expectedAccountId },
      users: [...users.values()].sort((left, right) => left.senderId.localeCompare(right.senderId)),
      groups: [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([threadId, group]) => {
        const chatId = this.#chatId(accountId, threadId, true)
        const name = group.title || `Instagram group ${threadId}`
        return {
          accountId,
          threadId,
          chatId,
          name,
          displayName: name,
          level: group.level ?? 'L5',
          observedOnly: group.saved !== true
        }
      })
    }
  }

  async updateConsoleSettings({ revision, action, ...params } = {}) {
    const reconnect = action === 'configure' || action === 'reconnect'
    await this.#serialize(async () => {
      this.#requireReady()
      if (revision !== this.state.revision) throw bridgeError('Instagram private settings changed; reload and try again', 409, 'ECONFLICT')
      const candidate = structuredClone(this.state)
      switch (action) {
        case 'configure': {
          const expected = cleanId(params.expectedAccountId, 'Expected account ID')
          if (candidate.settings.expectedAccountId !== null && candidate.settings.expectedAccountId !== expected) {
            throw bridgeError('Expected account ID cannot be changed', 409, 'EIMMUTABLE')
          }
          candidate.settings.expectedAccountId = expected
          candidate.channel.status = 'login_required'
          candidate.channel.account = null
          candidate.channel.autoReplyEnabled = false
          candidate.channel.groupRepliesEnabled = false
          candidate.channel.cutoff = this.now()
          candidate.channel.lastError = null
          break
        }
        case 'reconnect':
          if (candidate.settings.expectedAccountId === null) throw bridgeError('Instagram private account is not configured', 409)
          candidate.channel.cutoff = this.now()
          candidate.channel.lastError = null
          break
        case 'set-replies':
          if (typeof params.enabled !== 'boolean') throw bridgeError('enabled must be a boolean')
          this.#assertCandidateConnected(candidate)
          if (params.enabled && !candidate.channel.autoReplyEnabled) candidate.channel.cutoff = this.now()
          candidate.channel.autoReplyEnabled = params.enabled
          break
        case 'set-groups':
          if (typeof params.enabled !== 'boolean') throw bridgeError('enabled must be a boolean')
          this.#assertCandidateConnected(candidate)
          if (params.enabled && !candidate.channel.groupRepliesEnabled) candidate.channel.cutoff = this.now()
          candidate.channel.groupRepliesEnabled = params.enabled
          break
        case 'save-user': this.#saveUser(candidate, params); break
        case 'bind-owner': this.#bindOwner(candidate, params); break
        case 'unbind-owner': this.#unbindOwner(candidate, params); break
        case 'delete-user': this.#deleteUser(candidate, params); break
        case 'save-group': this.#saveGroup(candidate, params); break
        default: throw bridgeError('Unsupported Instagram private settings action')
      }
      candidate.revision += 1
      this.#prune(candidate)
      await this.#persist(candidate)
      this.state = candidate
    })
    if (reconnect) {
      await this.#replaceWorker()
      await this.#refreshConnection()
      this.#schedulePoll(this.pollIntervalMs)
    }
    return this.getConsoleState()
  }

  async getMessages({ chatId, limit = 30 } = {}) {
    const parsed = this.#parseChatId(chatId)
    const bounded = this.#limit(limit, 30, 100)
    const context = await this.#freshThread(parsed, { limit: 1 })
    if (!this.#freshReadAllowed(parsed, context)) return []
    return this.state.messages.filter((message) => message.chatId === chatId)
      .sort((left, right) => right.timestamp - left.timestamp).slice(0, bounded).map((message) => this.#publicMessage(message))
  }

  async listChats({ limit = 50, scope = 'all' } = {}) {
    const bounded = this.#limit(limit, 50, 50)
    if (!['all', 'private', 'groups'].includes(scope)) throw bridgeError('scope is invalid')
    if (!this.#connected()) return []
    const chats = new Map()
    for (const message of this.state.messages) {
      if (message.accountId !== this.state.channel.account.id) continue
      if (scope === 'private' && message.isGroup || scope === 'groups' && !message.isGroup) continue
      const existing = chats.get(message.chatId)
      if (!existing) chats.set(message.chatId, { latest: message, count: 1 })
      else {
        existing.count += 1
        if (message.timestamp > existing.latest.timestamp) existing.latest = message
      }
    }
    const result = []
    for (const [chatId, item] of [...chats.entries()].sort((left, right) => right[1].latest.timestamp - left[1].latest.timestamp)) {
      if (result.length >= bounded) break
      const parsed = this.#parseChatId(chatId)
      const context = await this.#freshThread(parsed, { limit: 1 })
      if (!this.#freshReadAllowed(parsed, context)) continue
      result.push({
        platform: 'instagram_private',
        accountId: parsed.accountId,
        chatId,
        isGroup: parsed.isGroup,
        title: context.thread.title,
        lastMessage: item.latest.text,
        lastTimestamp: item.latest.timestamp,
        messageCount: item.count
      })
    }
    return result
  }

  async getPendingReplies({ after, limit = 20 } = {}) {
    const cursor = after === undefined || after === null ? 0 : after
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw bridgeError('after is invalid')
    const bounded = this.#limit(limit, 20, 20)
    if (!this.#connected() || !this.state.channel.autoReplyEnabled) return []
    const now = this.now()
    const candidates = this.state.messages.filter((message) => message.accountId === this.state.channel.account.id
      && message.timestamp > cursor && message.timestamp > (this.state.channel.cutoff ?? now)
      && message.storedAt >= (this.state.channel.cutoff ?? now)
      && message.timestamp <= now + MAX_CLOCK_SKEW_MS && now - message.timestamp < REPLY_WINDOW_MS
      && (!message.isGroup || this.state.channel.groupRepliesEnabled)
      && !this.state.receipts.some((receipt) => receipt.accountId === message.accountId
        && receipt.chatId === message.chatId && receipt.sourceMessageId === message.id))
      .sort((left, right) => left.timestamp - right.timestamp)
    const result = []
    const contexts = new Map()
    for (const message of candidates) {
      if (result.length >= bounded) break
      let context = contexts.get(message.chatId)
      if (!context) {
        context = await this.#freshThread(this.#parseChatId(message.chatId), { limit: 50 })
        contexts.set(message.chatId, context)
      }
      const parsed = this.#parseChatId(message.chatId)
      if (this.#pendingAllowed(message) && this.#freshReadAllowed(parsed, context)
        && this.#sourceInThread(context.thread, message)) result.push(this.#publicMessage(message))
    }
    return result
  }

  async getMediaDescriptor({ chatId, messageId } = {}) {
    const parsed = this.#parseChatId(chatId)
    const id = cleanMessageId(messageId)
    const context = await this.#freshThread(parsed, { limit: 50 })
    if (!this.#freshReadAllowed(parsed, context)) return null
    const message = this.state.messages.find((item) => item.chatId === chatId && item.id === id)
    if (!message || !this.#sourceInThread(context.thread, message)) return null
    return message.descriptor ? structuredClone(message.descriptor) : null
  }

  async getGroupInfo({ chatId } = {}) {
    const parsed = this.#parseChatId(chatId)
    if (!parsed.isGroup) throw bridgeError('Chat is not a group')
    const context = await this.#freshThread(parsed, { limit: 1 })
    if (!this.#freshReadAllowed(parsed, context)) return null
    const access = this.#threadAccess(context.thread, parsed.accountId)
    return {
      id: chatId,
      title: context.thread.title,
      botPresent: access.botPresent,
      ownerPresent: access.ownerPresent
    }
  }

  async canDeliver(message) {
    if (!this.started || !this.valid || !isRecord(message) || !this.#connected()
      || !this.state.channel.autoReplyEnabled || message.platform !== 'instagram_private'
      || message.fromMe !== false || message.replyAllowed !== true) return false
    let parsed
    try { parsed = this.#parseChatId(message.chatId) } catch { return false }
    const stored = this.state.messages.find((item) => item.chatId === message.chatId && item.id === message.id)
    const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : message.timestamp
    const now = this.now()
    if (!stored || message.accountId !== stored.accountId || message.senderId !== stored.senderId || timestamp !== stored.timestamp
      || message.text !== stored.text || message.type !== stored.type || message.isGroup !== stored.isGroup
      || (message.mediaType ?? null) !== stored.mediaType || JSON.stringify(message.media ?? null) !== JSON.stringify(stored.media)
      || stored.timestamp <= (this.state.channel.cutoff ?? now) || stored.storedAt < (this.state.channel.cutoff ?? now)
      || stored.timestamp > now + MAX_CLOCK_SKEW_MS
      || now - stored.timestamp >= REPLY_WINDOW_MS || parsed.isGroup && !this.state.channel.groupRepliesEnabled) return false
    const context = await this.#freshThread(parsed, { limit: 50 })
    if (!this.#pendingAllowed(stored) || !this.#freshReadAllowed(parsed, context)
      || !this.#sourceInThread(context.thread, stored)) return false
    return this.#samePermission(message.permission, this.#permission(stored, context.thread))
  }

  async sendText({ chatId, sourceMessageId, text, idempotencyKey } = {}) {
    const cleanText = cleanString(text, 'Message text', 2000)
    return this.#send({ chatId, sourceMessageId, idempotencyKey, type: 'text', text: cleanText })
  }

  async sendImage({ chatId, sourceMessageId, data, mimetype, fileName, idempotencyKey } = {}) {
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_IMAGE_BYTES) throw bridgeError('Image data is invalid', 413)
    const mime = cleanString(mimetype, 'MIME type', 200)
    if (!['image/png', 'image/jpeg'].includes(mime)) throw bridgeError('MIME type is invalid')
    const name = fileName === undefined ? null : cleanString(fileName, 'File name', 255)
    return this.#send({ chatId, sourceMessageId, idempotencyKey, type: 'image', data, mimetype: mime, fileName: name })
  }

  async #send(input) {
    const operation = this.sendChain.then(() => this.#sendLocked(input))
    this.sendChain = operation.then(() => {}, () => {})
    return operation
  }

  async #sendLocked(input) {
      this.#requireReady()
      const parsed = this.#parseChatId(input.chatId)
      const sourceId = cleanMessageId(input.sourceMessageId, 'Source message ID')
      cleanString(input.idempotencyKey, 'Idempotency key', 200)
      const receiptKey = `${parsed.accountId}:${input.chatId}:${sourceId}`
      const payloadHash = digest(input.type === 'text'
        ? JSON.stringify({ type: input.type, text: input.text })
        : Buffer.concat([Buffer.from(JSON.stringify({ type: input.type, mimetype: input.mimetype, fileName: input.fileName })), input.data]))
      const existing = this.state.receipts.find((receipt) => receipt.key === receiptKey)
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw bridgeError('Source message already has a different reply', 409, 'EIDEMPOTENCY')
        if (existing.status === 'sent') return { messageId: existing.messageId }
        throw bridgeError('Previous send outcome is unknown; manual review is required', 409, 'EUNKNOWN')
      }
      const source = this.state.messages.find((message) => message.chatId === input.chatId && message.id === sourceId)
      this.#assertSendState(parsed, source)
      let context = await this.#freshThread(parsed, { limit: 50 })
      this.#assertFreshSend(context, source)
      await this.#serialize(async () => {
        this.#requireReady()
        const currentReceipt = this.state.receipts.find((receipt) => receipt.key === receiptKey)
        if (currentReceipt) {
          if (currentReceipt.payloadHash !== payloadHash) throw bridgeError('Source message already has a different reply', 409, 'EIDEMPOTENCY')
          if (currentReceipt.status === 'sent') return
          throw bridgeError('Previous send outcome is unknown; manual review is required', 409, 'EUNKNOWN')
        }
        const currentSource = this.state.messages.find((message) => message.chatId === input.chatId && message.id === sourceId)
        this.#assertSendState(parsed, currentSource)
        const reserved = structuredClone(this.state)
        reserved.receipts.push({
          key: receiptKey,
          payloadHash,
          status: 'unknown',
          messageId: null,
          updatedAt: this.now(),
          accountId: parsed.accountId,
          chatId: input.chatId,
          sourceMessageId: sourceId
        })
        this.#prune(reserved)
        await this.#persist(reserved)
        this.state = reserved
      })
      const currentSource = this.state.messages.find((message) => message.chatId === input.chatId && message.id === sourceId)
      this.#assertSendState(parsed, currentSource)
      context = await this.#freshThread(parsed, { limit: 50 })
      const finalSource = this.state.messages.find((message) => message.chatId === input.chatId && message.id === sourceId)
      this.#assertSendState(parsed, finalSource)
      this.#assertFreshSend(context, finalSource)
      let result
      try {
        result = input.type === 'text'
          ? await this.worker.request('send_text', { threadId: parsed.threadId, sourceMessageId: sourceId, text: input.text })
          : await this.worker.request('send_image', {
            threadId: parsed.threadId,
            sourceMessageId: sourceId,
            data: input.data.toString('base64'),
            mimetype: input.mimetype
          })
      } catch (error) {
        await this.#recordWorkerFailure(error).catch(() => {})
        throw bridgeError('Instagram private send outcome is unknown; manual review is required', 502, 'EUNKNOWN')
      }
      if (!hasOnlyKeys(result, new Set(['messageId', 'timestamp'])) || !validMessageId(result.messageId)
        || !Number.isSafeInteger(result.timestamp) || result.timestamp < 0) {
        throw bridgeError('Instagram private send result is incomplete', 502, 'EUNKNOWN')
      }
      await this.#serialize(async () => {
        const sent = structuredClone(this.state)
        const receipt = sent.receipts.find((item) => item.key === receiptKey)
        if (!receipt || receipt.payloadHash !== payloadHash) throw bridgeError('Instagram private receipt changed', 409, 'EUNKNOWN')
        receipt.status = 'sent'
        receipt.messageId = result.messageId
        receipt.updatedAt = this.now()
        sent.channel.lastError = null
        await this.#persist(sent)
        this.state = sent
      })
      return { messageId: result.messageId }
  }

  async #pollOnce() {
    if (this.polling || !this.started || !this.valid || !this.#connected()) return
    this.polling = true
    try {
      const result = await this.worker.request('poll', { limit: 20 })
      if (!hasOnlyKeys(result, new Set(['account', 'threads'])) || !validAccount(result.account)
        || !Array.isArray(result.threads) || result.threads.length > 20) throw bridgeError('Instagram poll result is invalid', 502, 'EPROTOCOL')
      if (result.account.id !== this.state.settings.expectedAccountId || result.account.id !== this.state.channel.account.id) {
        await this.#accountMismatch()
        return
      }
      const threads = result.threads.map(normalizeThread)
      if (threads.some((thread) => thread === null)) throw bridgeError('Instagram poll result is invalid', 502, 'EPROTOCOL')
      for (const thread of threads) await this.#ingestThread(thread)
      this.backoffMs = this.pollIntervalMs
    } catch (error) {
      await this.#recordWorkerFailure(error).catch(() => {})
    } finally {
      this.polling = false
    }
  }

  async #ingestThread(thread) {
    for (const raw of thread.messages) {
      const prepared = await this.#serialize(async () => {
        if (!this.started || !this.#connected() || !thread.memberIds.includes(this.state.channel.account.id)) return null
        const accountId = this.state.channel.account.id
        const access = this.#threadAccess(thread, accountId)
        if (!access.allowed) return null
        const now = this.now()
        if (raw.fromMe || raw.senderId === accountId || !thread.memberIds.includes(raw.senderId)
          || raw.timestamp <= (this.state.channel.cutoff ?? now) || raw.timestamp > now + MAX_CLOCK_SKEW_MS
          || now - raw.timestamp >= REPLY_WINDOW_MS) return null
        const key = `${accountId}:${thread.id}:${raw.id}`
        if (this.state.dedupe.some((item) => item.key === key)) return null
        let message = this.state.messages.find((item) => item.accountId === accountId && item.threadId === thread.id && item.id === raw.id)
        if (!message) {
          const candidate = structuredClone(this.state)
          message = this.#storedMessage(accountId, thread, raw, now)
          candidate.messages.push(message)
          this.#prune(candidate)
          await this.#persist(candidate)
          this.state = candidate
        }
        return { key, message: structuredClone(message), eligible: this.#replyEnabled(message), at: now }
      })
      if (!prepared) continue
      const parsed = this.#parseChatId(prepared.message.chatId)
      if (prepared.eligible && this.#pendingAllowed(prepared.message)
        && this.#freshReadAllowed(parsed, { thread })) {
        try { await this.#publishMessage(this.#publicMessage(prepared.message, thread)) } catch { continue }
      }
      await this.#serialize(async () => {
        const acknowledged = structuredClone(this.state)
        if (!acknowledged.dedupe.some((item) => item.key === prepared.key)) {
          acknowledged.dedupe.push({ key: prepared.key, at: prepared.at })
        }
        this.#prune(acknowledged)
        await this.#persist(acknowledged)
        this.state = acknowledged
      })
    }
  }

  #storedMessage(accountId, thread, message, storedAt) {
    const descriptor = message.media ? {
      url: message.media.url,
      mimetype: message.media.mimetype,
      fileName: message.media.fileName,
      mediaType: message.mediaType
    } : null
    return {
      accountId,
      chatId: this.#chatId(accountId, thread.id, thread.isGroup),
      threadId: thread.id,
      id: message.id,
      senderId: message.senderId,
      text: message.text,
      timestamp: message.timestamp,
      storedAt,
      fromMe: false,
      type: message.media ? 'media' : 'text',
      isGroup: thread.isGroup,
      title: thread.title,
      mediaType: message.mediaType,
      media: message.media ? { mimetype: message.media.mimetype, fileName: message.media.fileName } : null,
      descriptor,
      replyToMessageId: message.replyToMessageId
    }
  }

  #publicMessage(message, thread = null) {
    const permission = this.#permission(message, thread)
    return {
      platform: 'instagram_private',
      accountId: message.accountId,
      chatId: message.chatId,
      id: message.id,
      senderId: message.senderId,
      text: message.text,
      timestamp: message.timestamp,
      fromMe: false,
      type: message.type,
      isGroup: message.isGroup,
      ...(message.mediaType ? { mediaType: message.mediaType } : {}),
      ...(message.media ? { media: structuredClone(message.media) } : {}),
      permission,
      replyAllowed: this.#replyEnabled(message)
    }
  }

  #permission(message, thread = null) {
    const user = this.#user(message.accountId, message.senderId)
    const actorIsOwner = Boolean(user?.ownerId && this.#ownerSet().has(user.ownerId))
    const actorLevel = actorIsOwner ? 'L1' : (user?.level ?? 'L5')
    const group = message.isGroup ? this.#group(message.accountId, message.threadId) : null
    const roomLevel = message.isGroup ? (group?.level ?? 'L5') : actorLevel
    const effectiveLevel = `L${Math.max(Number(actorLevel.slice(1)), Number(roomLevel.slice(1)))}`
    const privateOwner = this.valid && !message.isGroup && actorIsOwner
    return {
      mode: 'rules_only',
      actorLevel,
      roomLevel,
      effectiveLevel,
      audience: message.isGroup ? 'group' : 'private',
      actorIsOwner,
      policyValid: this.valid,
      privateDataAllowed: privateOwner,
      managePermissionsAllowed: privateOwner
    }
  }

  #samePermission(left, right) {
    return isRecord(left) && ['mode', 'actorLevel', 'roomLevel', 'effectiveLevel', 'audience', 'actorIsOwner',
      'policyValid', 'privateDataAllowed', 'managePermissionsAllowed'].every((key) => left[key] === right[key])
  }

  #threadAccess(thread, accountId) {
    const botPresent = thread.memberIds.includes(accountId)
    if (!botPresent) return { allowed: false, botPresent, ownerPresent: false }
    const ownerPresent = thread.memberIds.some((senderId) => {
      const user = this.#user(accountId, senderId)
      return Boolean(user?.ownerId && this.#ownerSet().has(user.ownerId))
    })
    if (thread.isGroup) return { allowed: ownerPresent, botPresent, ownerPresent }
    const peers = thread.memberIds.filter((id) => id !== accountId)
    return { allowed: peers.length === 1, botPresent, ownerPresent }
  }

  async #freshThread(parsed, { limit }) {
    if (!this.#connected() || parsed.accountId !== this.state.channel.account.id) return { allowed: false }
    const result = normalizeThread(await this.worker.request('thread', { threadId: parsed.threadId, limit }))
    if (!result || result.id !== parsed.threadId || result.isGroup !== parsed.isGroup) return { allowed: false }
    const access = this.#threadAccess(result, parsed.accountId)
    return { ...access, thread: result }
  }

  #sourceInThread(thread, source) {
    const fresh = thread.messages.find((message) => message.id === source.id)
    return Boolean(fresh && !fresh.fromMe && fresh.senderId === source.senderId && fresh.timestamp === source.timestamp
      && fresh.text === source.text && fresh.mediaType === source.mediaType
      && (fresh.media?.url ?? null) === (source.descriptor?.url ?? null)
      && (fresh.media?.mimetype ?? null) === (source.media?.mimetype ?? null)
      && (fresh.media?.fileName ?? null) === (source.media?.fileName ?? null)
      && fresh.replyToMessageId === source.replyToMessageId)
  }

  #freshReadAllowed(parsed, context) {
    return Boolean(context?.thread && this.#connected() && parsed.accountId === this.state.channel.account.id
      && context.thread.id === parsed.threadId && context.thread.isGroup === parsed.isGroup
      && this.#threadAccess(context.thread, parsed.accountId).allowed)
  }

  #pendingAllowed(message) {
    const now = this.now()
    return this.#connected() && this.state.channel.autoReplyEnabled
      && message.accountId === this.state.channel.account.id
      && (!message.isGroup || this.state.channel.groupRepliesEnabled)
      && message.timestamp > (this.state.channel.cutoff ?? now)
      && message.storedAt >= (this.state.channel.cutoff ?? now)
      && message.timestamp <= now + MAX_CLOCK_SKEW_MS && now - message.timestamp < REPLY_WINDOW_MS
      && !this.state.receipts.some((receipt) => receipt.accountId === message.accountId
        && receipt.chatId === message.chatId && receipt.sourceMessageId === message.id)
  }

  #replyEnabled(message) {
    return this.#connected() && this.state.channel.autoReplyEnabled && (!message.isGroup || this.state.channel.groupRepliesEnabled)
  }

  #assertSendState(parsed, source) {
    const now = this.now()
    if (!this.#connected() || parsed.accountId !== this.state.channel.account.id) throw bridgeError('Instagram private account is not connected', 409)
    if (!this.state.channel.autoReplyEnabled || parsed.isGroup && !this.state.channel.groupRepliesEnabled) {
      throw bridgeError('Automatic replies are paused', 409)
    }
    if (!source || source.accountId !== parsed.accountId || source.threadId !== parsed.threadId || source.isGroup !== parsed.isGroup) {
      throw bridgeError('Source message is unavailable', 404)
    }
    if (source.timestamp <= (this.state.channel.cutoff ?? now) || source.storedAt < (this.state.channel.cutoff ?? now)
      || source.timestamp > now + MAX_CLOCK_SKEW_MS
      || now - source.timestamp >= REPLY_WINDOW_MS) throw bridgeError('Source message is outside the reply session', 409)
  }

  #assertFreshSend(context, source) {
    if (!context?.thread || !this.#threadAccess(context.thread, source.accountId).allowed
      || !this.#sourceInThread(context.thread, source)) throw bridgeError('Source message or membership changed', 409)
    this.#permission(source, context.thread)
  }

  #saveUser(state, { senderId, displayName, level }) {
    const account = this.#connectedAccount(state)
    const sender = cleanId(senderId, 'Sender ID')
    const name = cleanString(displayName, 'Display name', 100)
    if (!LEVELS.has(level)) throw bridgeError('User level must be L2 to L5')
    if (!this.#observed(account.id, sender, state)) throw bridgeError('Sender has not been observed for this account', 404)
    const user = this.#user(account.id, sender, state)
    if (user) Object.assign(user, { displayName: name, level })
    else state.users.push({ accountId: account.id, senderId: sender, displayName: name, level, ownerId: null })
  }

  #bindOwner(state, { senderId, ownerId }) {
    const account = this.#connectedAccount(state)
    const sender = cleanId(senderId, 'Sender ID')
    const owner = cleanString(ownerId, 'Owner ID', 256)
    if (!this.#ownerSet().has(owner)) throw bridgeError('Owner ID is not active', 403)
    if (!this.#observed(account.id, sender, state)) throw bridgeError('Sender has not been observed for this account', 404)
    let user = this.#user(account.id, sender, state)
    if (!user) {
      user = { accountId: account.id, senderId: sender, displayName: sender, level: 'L5', ownerId: null }
      state.users.push(user)
    }
    user.ownerId = owner
  }

  #unbindOwner(state, { senderId }) {
    const account = this.#connectedAccount(state)
    const user = this.#user(account.id, cleanId(senderId, 'Sender ID'), state)
    if (!user) throw bridgeError('User is unavailable', 404)
    user.ownerId = null
  }

  #deleteUser(state, { senderId }) {
    const account = this.#connectedAccount(state)
    const sender = cleanId(senderId, 'Sender ID')
    const index = state.users.findIndex((user) => user.accountId === account.id && user.senderId === sender)
    if (index < 0) return
    if (state.users[index].ownerId !== null) throw bridgeError('Unbind the owner before deleting this user', 409)
    state.users.splice(index, 1)
  }

  #saveGroup(state, { chatId, level }) {
    const account = this.#connectedAccount(state)
    const parsed = this.#parseChatId(chatId)
    if (!parsed.isGroup || parsed.accountId !== account.id) throw bridgeError('Group scope is invalid', 409)
    if (!LEVELS.has(level)) throw bridgeError('Group level must be L2 to L5')
    if (!state.messages.some((message) => message.accountId === account.id && message.threadId === parsed.threadId && message.isGroup)) {
      throw bridgeError('Group has not been observed for this account', 404)
    }
    const group = this.#group(account.id, parsed.threadId, state)
    if (group) group.level = level
    else state.groups.push({ accountId: account.id, threadId: parsed.threadId, level })
  }

  #publicUser(user) {
    const actorIsOwner = Boolean(user.ownerId && this.#ownerSet().has(user.ownerId))
    return {
      accountId: user.accountId,
      senderId: user.senderId,
      displayName: user.displayName,
      level: actorIsOwner ? 'L1' : user.level,
      ownerId: actorIsOwner ? user.ownerId : null,
      actorIsOwner
    }
  }

  #publicChannel() {
    const channel = this.state.channel
    const status = channel.status === 'connected' && !channel.autoReplyEnabled ? 'paused' : channel.status
    return {
      status: this.valid ? status : 'error',
      account: publicAccount(channel.account),
      autoReplyEnabled: channel.autoReplyEnabled,
      groupRepliesEnabled: channel.groupRepliesEnabled,
      capabilities: { direct: true, groups: true, text: true, image: true },
      lastError: channel.lastError
    }
  }

  async #refreshConnection() {
    if (!this.started || !this.valid || this.state.settings.expectedAccountId === null) return
    this.#ensureWorker()
    try {
      const result = normalizeWorkerStatus(await this.worker.request('status', {}))
      await this.#serialize(async () => {
        if (!this.started || !this.valid) return
        const candidate = structuredClone(this.state)
        if (result.status === 'connected' && result.account.id !== candidate.settings.expectedAccountId) {
          candidate.channel.status = 'error'
          candidate.channel.account = null
          candidate.channel.autoReplyEnabled = false
          candidate.channel.groupRepliesEnabled = false
          candidate.channel.lastError = 'Connected Instagram account does not match the configured account'
        } else if (result.status === 'connected') {
          candidate.channel.status = 'connected'
          candidate.channel.account = result.account
          candidate.channel.lastError = null
          this.backoffMs = this.pollIntervalMs
        } else {
          candidate.channel.status = result.status === 'provider_error' ? 'error' : result.status
          candidate.channel.account = null
          candidate.channel.autoReplyEnabled = false
          candidate.channel.groupRepliesEnabled = false
          candidate.channel.lastError = result.status === 'provider_error' ? 'Instagram worker is unavailable' : null
          const requestedBackoff = result.retryAfter === undefined ? this.backoffMs * 2 : result.retryAfter * 1000
          this.backoffMs = Math.min(Math.max(requestedBackoff, this.pollIntervalMs), MAX_BACKOFF_MS)
        }
        await this.#persist(candidate)
        this.state = candidate
      })
    } catch (error) {
      await this.#recordWorkerFailure(error).catch(() => {})
    }
  }

  async #recordWorkerFailure(error) {
    if (!this.started || !this.valid) return
    await this.#serialize(async () => {
      if (!this.started || !this.valid) return
      const candidate = structuredClone(this.state)
      const code = String(error?.code || '').toUpperCase()
      if (code.includes('LOGIN')) candidate.channel.status = 'login_required'
      else if (code.includes('CHALLENGE')) candidate.channel.status = 'challenge_required'
      else if (code.includes('RATE')) candidate.channel.status = 'rate_limited'
      else candidate.channel.status = 'error'
      candidate.channel.account = null
      candidate.channel.autoReplyEnabled = false
      candidate.channel.groupRepliesEnabled = false
      candidate.channel.lastError = candidate.channel.status === 'error' ? 'Instagram worker is unavailable' : null
      const requestedBackoff = Number.isSafeInteger(error?.retryAfter) && error.retryAfter >= 1
        ? error.retryAfter * 1000
        : this.backoffMs * 2
      this.backoffMs = Math.min(Math.max(requestedBackoff, this.pollIntervalMs), MAX_BACKOFF_MS)
      await this.#persist(candidate)
      this.state = candidate
    })
  }

  async #accountMismatch() {
    await this.#serialize(async () => {
      const candidate = structuredClone(this.state)
      candidate.channel.status = 'error'
      candidate.channel.account = null
      candidate.channel.autoReplyEnabled = false
      candidate.channel.groupRepliesEnabled = false
      candidate.channel.lastError = 'Connected Instagram account does not match the configured account'
      await this.#persist(candidate)
      this.state = candidate
    })
  }

  #schedulePoll(delay) {
    if (!this.started || this.state.settings.expectedAccountId === null) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      if (!this.started) return
      if (this.#connected()) await this.#pollOnce()
      else await this.#refreshConnection()
      this.#schedulePoll(this.#connected() ? this.pollIntervalMs : this.backoffMs)
    }, Math.min(Math.max(delay, 10), MAX_BACKOFF_MS))
    this.pollTimer.unref?.()
  }

  async #replaceWorker() {
    if (typeof this.workerSource !== 'function') return
    await this.worker?.stop?.().catch(() => {})
    this.worker = null
    this.#ensureWorker()
  }

  #ensureWorker() {
    if (this.worker) return this.worker
    const expectedAccountId = this.state.settings.expectedAccountId
    if (expectedAccountId === null) throw bridgeError('Instagram private account is not configured', 409)
    this.worker = this.workerSource({ dataDir: this.dataDir, expectedAccountId })
    if (!isRecord(this.worker) || typeof this.worker.request !== 'function') throw new TypeError('worker factory returned an invalid worker')
    return this.worker
  }

  #connected(state = this.state) {
    return this.started && this.valid && state.channel.status === 'connected' && state.channel.account !== null
      && state.channel.account.id === state.settings.expectedAccountId
  }

  #assertCandidateConnected(state) {
    if (!this.#connected(state)) throw bridgeError('Instagram private account is not connected', 409)
  }

  #connectedAccount(state = this.state) {
    this.#assertCandidateConnected(state)
    return state.channel.account
  }

  #chatId(accountId, threadId, isGroup) {
    return `instagram_private:${accountId}:${isGroup ? 'group' : 'dm'}:${threadId}`
  }

  #parseChatId(value) {
    if (typeof value !== 'string') throw bridgeError('Chat ID is invalid')
    const match = /^instagram_private:(\d{1,64}):(dm|group):(\d{1,64})$/.exec(value)
    if (!match) throw bridgeError('Chat ID is invalid')
    return { accountId: match[1], isGroup: match[2] === 'group', threadId: match[3] }
  }

  #observed(accountId, senderId, state = this.state) {
    return state.messages.some((message) => message.accountId === accountId && message.senderId === senderId)
  }

  #user(accountId, senderId, state = this.state) {
    return state.users.find((user) => user.accountId === accountId && user.senderId === senderId)
  }

  #group(accountId, threadId, state = this.state) {
    return state.groups.find((group) => group.accountId === accountId && group.threadId === threadId)
  }

  #ownerSet() {
    let values
    try { values = this.ownerIds() } catch { return new Set() }
    return new Set(values instanceof Set || Array.isArray(values) ? values : [])
  }

  #limit(value, fallback, maximum) {
    const result = value === undefined ? fallback : value
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw bridgeError('limit is invalid')
    return result
  }

  async #publishMessage(message) {
    if (this.messagePublisher) return this.messagePublisher(message)
    await Promise.all(this.rawListeners('message').map((listener) => listener.call(this, message)))
  }

  #requireReady() {
    if (!this.started) throw bridgeError('Instagram private bridge is not started', 503)
    if (!this.valid) throw bridgeError('Instagram private state is unavailable', 503)
  }

  #serialize(callback) {
    const result = this.mutationChain.then(callback, callback)
    this.mutationChain = result.then(() => {}, () => {})
    return result
  }

  #prune(state = this.state) {
    const threshold = this.now() - RETENTION_MS
    state.messages = state.messages.filter((message) => message.storedAt >= threshold).slice(-MAX_MESSAGES)
    state.dedupe = state.dedupe.filter((item) => item.at >= threshold).slice(-MAX_MESSAGES)
    state.receipts = state.receipts.filter((receipt) => receipt.updatedAt >= threshold).slice(-MAX_RECEIPTS)
  }

  async #load() {
    let handle
    try {
      handle = await open(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileStat = await handle.stat()
      if (!fileStat.isFile() || fileStat.size > MAX_STATE_BYTES || (fileStat.mode & 0o777) !== 0o600) throw bridgeError('Unsafe Instagram private state', 503)
      const state = JSON.parse(await handle.readFile('utf8'))
      if (!validState(state)) throw bridgeError('Invalid Instagram private state', 503)
      return state
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const state = defaultState()
      await this.#persist(state)
      return state
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async #persist(state) {
    const data = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw bridgeError('Instagram private state exceeds its storage limit', 413)
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.statePath)
      await chmod(this.statePath, 0o600)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
