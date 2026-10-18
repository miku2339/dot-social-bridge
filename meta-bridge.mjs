import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATE_VERSION = 1
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_WEBHOOK_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MESSAGES = 500
const MAX_DEDUPE = 1000
const MAX_RECEIPTS = 500
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
const OAUTH_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const PLATFORMS = new Set(['instagram', 'facebook'])
const LEVELS = new Set(['L2', 'L3', 'L4', 'L5'])
const META_ID = /^\d{1,64}$/
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ALLOWED_HOSTS = new Set([
  'www.instagram.com',
  'api.instagram.com',
  'graph.instagram.com',
  'www.facebook.com',
  'graph.facebook.com'
])

function bridgeError(message, status = 400, code = 'EMETA') {
  return Object.assign(new Error(message), { status, statusCode: status, code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => !RESERVED_KEYS.has(key) && allowed.has(key))
}

function platformName(value) {
  if (!PLATFORMS.has(value)) throw bridgeError('Unsupported Meta platform')
  return value
}

function cleanString(value, name, maximum, { optional = false, allowEmpty = false } = {}) {
  if ((value === undefined || value === null) && optional) return null
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw bridgeError(`${name} is invalid`)
  }
  return value
}

function cleanMetaId(value, name = 'Meta ID') {
  if (typeof value !== 'string' || !META_ID.test(value)) throw bridgeError(`${name} is invalid`)
  return value
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function defaultPlatform() {
  return {
    config: { appId: '', appSecret: '', verifyToken: '' },
    status: 'not_configured',
    account: null,
    assets: [],
    autoReplyEnabled: false,
    cutoff: null,
    accessToken: null,
    tokenExpiresAt: null,
    lastError: null
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    platforms: {
      instagram: defaultPlatform(),
      facebook: defaultPlatform()
    },
    oauth: [],
    users: [],
    messages: [],
    dedupe: [],
    receipts: []
  }
}

function validateConfig(value) {
  return hasOnlyKeys(value, new Set(['appId', 'appSecret', 'verifyToken']))
    && ['appId', 'appSecret', 'verifyToken'].every((key) => typeof value[key] === 'string' && value[key].length <= 4096)
}

function validateAccount(value, { token = false } = {}) {
  if (!hasOnlyKeys(value, new Set(['id', 'name', 'username', ...(token ? ['accessToken', 'tokenExpiresAt'] : [])]))) return false
  return META_ID.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200
    && (value.username === undefined || value.username === null || (typeof value.username === 'string' && value.username.length <= 200))
    && (!token || value.accessToken === null || (typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 8192))
    && (!token || (Number.isSafeInteger(value.tokenExpiresAt) && value.tokenExpiresAt > 0))
}

function validatePlatform(value) {
  const statuses = new Set(['not_configured', 'ready_to_authorize', 'select_account', 'connected', 'expired', 'error'])
  const structurallyValid = hasOnlyKeys(value, new Set([
    'config', 'status', 'account', 'assets', 'autoReplyEnabled', 'cutoff', 'accessToken', 'tokenExpiresAt', 'lastError'
  ]))
    && validateConfig(value.config)
    && statuses.has(value.status)
    && (value.account === null || validateAccount(value.account))
    && Array.isArray(value.assets) && value.assets.length <= 100 && value.assets.every((asset) => validateAccount(asset, { token: true }))
    && typeof value.autoReplyEnabled === 'boolean'
    && (value.cutoff === null || (Number.isSafeInteger(value.cutoff) && value.cutoff >= 0))
    && (value.accessToken === null || (typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 8192))
    && (value.tokenExpiresAt === null || (Number.isSafeInteger(value.tokenExpiresAt) && value.tokenExpiresAt > 0))
    && (value.lastError === null || (typeof value.lastError === 'string' && value.lastError.length <= 500))
  if (!structurallyValid) return false
  if (value.status === 'connected') return value.account !== null && value.accessToken !== null
    && value.tokenExpiresAt !== null && value.cutoff !== null
  if (value.account !== null && value.accessToken === null) return false
  return true
}

function uniqueBy(values, key) {
  const seen = new Set()
  for (const value of values) {
    const identity = key(value)
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

function validateState(state) {
  if (!hasOnlyKeys(state, new Set(['version', 'revision', 'platforms', 'oauth', 'users', 'messages', 'dedupe', 'receipts']))) return false
  if (state.version !== STATE_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0) return false
  if (!hasOnlyKeys(state.platforms, new Set(['instagram', 'facebook']))) return false
  if (!validatePlatform(state.platforms.instagram) || !validatePlatform(state.platforms.facebook)) return false
  if (!Array.isArray(state.oauth) || state.oauth.length > 20 || !state.oauth.every((item) => (
    hasOnlyKeys(item, new Set(['platform', 'stateHash', 'sessionHash', 'expiresAt']))
    && PLATFORMS.has(item.platform)
    && /^[a-f0-9]{64}$/.test(item.stateHash)
    && /^[a-f0-9]{64}$/.test(item.sessionHash)
    && Number.isSafeInteger(item.expiresAt) && item.expiresAt > 0
  )) || !uniqueBy(state.oauth, (item) => item.stateHash)) return false
  if (!Array.isArray(state.users) || state.users.length > 1000 || !state.users.every((user) => (
    hasOnlyKeys(user, new Set(['platform', 'accountId', 'senderId', 'displayName', 'level', 'ownerId']))
    && PLATFORMS.has(user.platform) && META_ID.test(user.accountId) && META_ID.test(user.senderId)
    && typeof user.displayName === 'string' && user.displayName.length > 0 && user.displayName.length <= 100
    && LEVELS.has(user.level)
    && (user.ownerId === null || (typeof user.ownerId === 'string' && user.ownerId.length > 0 && user.ownerId.length <= 256))
  )) || !uniqueBy(state.users, (user) => `${user.platform}:${user.accountId}:${user.senderId}`)) return false
  if (!Array.isArray(state.messages) || state.messages.length > MAX_MESSAGES || !state.messages.every(validateStoredMessage)
    || !uniqueBy(state.messages, (message) => `${message.platform}:${message.accountId}:${message.chatId}:${message.id}`)) return false
  if (!Array.isArray(state.dedupe) || state.dedupe.length > MAX_DEDUPE || !state.dedupe.every((item) => (
    hasOnlyKeys(item, new Set(['key', 'at'])) && typeof item.key === 'string' && item.key.length <= 300
    && Number.isSafeInteger(item.at) && item.at >= 0
  )) || !uniqueBy(state.dedupe, (item) => item.key)) return false
  return Array.isArray(state.receipts) && state.receipts.length <= MAX_RECEIPTS && state.receipts.every((item) => (
    hasOnlyKeys(item, new Set([
      'key', 'payloadHash', 'status', 'messageId', 'updatedAt', 'platform', 'accountId', 'chatId', 'sourceMessageId'
    ]))
    && typeof item.key === 'string' && item.key.length <= 500
    && /^[a-f0-9]{64}$/.test(item.payloadHash)
    && ['inflight', 'sent', 'unknown'].includes(item.status)
    && (item.messageId === null || (typeof item.messageId === 'string' && item.messageId.length <= 500))
    && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0
    && PLATFORMS.has(item.platform) && META_ID.test(item.accountId)
    && typeof item.chatId === 'string' && item.chatId.startsWith(`${item.platform}:${item.accountId}:`)
    && META_ID.test(item.chatId.slice(item.chatId.lastIndexOf(':') + 1))
    && typeof item.sourceMessageId === 'string' && item.sourceMessageId.length > 0 && item.sourceMessageId.length <= 500
  )) && uniqueBy(state.receipts, (item) => item.key)
}

function validateStoredMessage(message) {
  return hasOnlyKeys(message, new Set([
    'platform', 'accountId', 'chatId', 'id', 'senderId', 'text', 'timestamp', 'storedAt', 'fromMe', 'type',
    'mediaType', 'media', 'descriptor', 'sourceMessageId'
  ]))
    && PLATFORMS.has(message.platform) && META_ID.test(message.accountId) && META_ID.test(message.senderId)
    && message.chatId === `${message.platform}:${message.accountId}:${message.senderId}`
    && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 500
    && (message.text === null || (typeof message.text === 'string' && message.text.length <= 4000))
    && Number.isSafeInteger(message.timestamp) && message.timestamp >= 0
    && Number.isSafeInteger(message.storedAt) && message.storedAt >= 0
    && typeof message.fromMe === 'boolean'
    && ['text', 'media'].includes(message.type)
    && (message.mediaType === null || (typeof message.mediaType === 'string' && message.mediaType.length <= 50))
    && (message.media === null || (hasOnlyKeys(message.media, new Set(['mimetype', 'fileName']))
      && (message.media.mimetype === null || typeof message.media.mimetype === 'string')
      && (message.media.mimetype === null || message.media.mimetype.length <= 200)
      && (message.media.fileName === null || (typeof message.media.fileName === 'string' && message.media.fileName.length <= 255))))
    && (message.descriptor === null || (hasOnlyKeys(message.descriptor, new Set(['download_url', 'file_id', 'mime_type', 'file_name', 'mediaType']))
      && typeof message.descriptor.download_url === 'string' && message.descriptor.download_url.length <= 4096
      && typeof message.descriptor.file_id === 'string' && message.descriptor.file_id.length <= 500
      && (message.descriptor.mime_type === undefined || (typeof message.descriptor.mime_type === 'string' && message.descriptor.mime_type.length <= 200))
      && (message.descriptor.file_name === undefined || (typeof message.descriptor.file_name === 'string' && message.descriptor.file_name.length <= 255))
      && typeof message.descriptor.mediaType === 'string' && message.descriptor.mediaType.length <= 50))
    && (message.sourceMessageId === null || (typeof message.sourceMessageId === 'string' && message.sourceMessageId.length <= 500))
}

function configured(platform) {
  return Boolean(platform.config.appId && platform.config.appSecret && platform.config.verifyToken)
}

function publicAccount(account) {
  if (!account) return null
  return {
    id: account.id,
    name: account.name,
    ...(account.username ? { username: account.username } : {})
  }
}

function safeTimestamp(value) {
  if (!Number.isFinite(value) || value < 0) return null
  const rounded = Math.trunc(value)
  return rounded < 1_000_000_000_000 ? rounded * 1000 : rounded
}

function boundedText(value, maximum = 4000) {
  if (typeof value !== 'string') return null
  return value.slice(0, maximum)
}

function safeLabel(value, maximum) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, maximum)
  return cleaned || null
}

function attachmentInfo(attachment, messageId) {
  if (!isRecord(attachment) || !isRecord(attachment.payload)) return null
  const url = attachment.payload.url
  if (typeof url !== 'string' || url.length < 1 || url.length > 4096) return null
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  const mediaType = ['image', 'video', 'audio', 'file'].includes(attachment.type) ? attachment.type : 'file'
  const rawMimeType = typeof attachment.payload.mime_type === 'string' ? attachment.payload.mime_type.toLowerCase() : ''
  const mimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(rawMimeType) ? rawMimeType.slice(0, 200) : null
  const fileName = safeLabel(attachment.payload.name, 255)
  const fileId = String(attachment.payload.attachment_id || attachment.payload.id || messageId).slice(0, 500)
  return {
    mediaType,
    media: { mimetype: mimeType, fileName },
    descriptor: {
      download_url: url,
      file_id: fileId,
      ...(mimeType ? { mime_type: mimeType } : {}),
      ...(fileName ? { file_name: fileName } : {}),
      mediaType
    }
  }
}

export class MetaBridge extends EventEmitter {
  constructor({
    dataDir,
    publicUrl,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    ownerIds = () => [],
    allowInsecureHttp = false
  } = {}) {
    super()
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required')
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
    if (typeof now !== 'function' || typeof ownerIds !== 'function') throw new TypeError('now and ownerIds must be functions')
    let parsed
    try { parsed = new URL(publicUrl) } catch { throw new TypeError('publicUrl is invalid') }
    if ((parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError('publicUrl must be an allowed origin')
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, '')
    parsed.search = ''
    this.dataDir = dataDir
    this.statePath = join(dataDir, 'meta-state.json')
    this.publicUrl = parsed.toString().replace(/\/$/, '')
    this.now = now
    this.fetchImpl = fetchImpl
    this.ownerIds = ownerIds
    this.state = defaultState()
    this.started = false
    this.valid = true
    this.messagePublisher = null
    this.mutationChain = Promise.resolve()
  }

  async start() {
    if (this.started) return this.getConsoleState()
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    try {
      this.state = await this.#load()
      this.valid = true
      this.#prune()
      const now = this.now()
      for (const platform of PLATFORMS) {
        const current = this.state.platforms[platform]
        if (current.status === 'connected') current.cutoff = now
      }
      await this.#persist()
    } catch (error) {
      this.valid = false
      this.state = defaultState()
      for (const platform of PLATFORMS) {
        this.state.platforms[platform].status = 'error'
        this.state.platforms[platform].lastError = 'Meta state is unavailable'
      }
    }
    this.started = true
    return this.getConsoleState()
  }

  async stop() {
    await this.mutationChain.catch(() => {})
    this.started = false
  }

  setMessagePublisher(publisher) {
    if (publisher !== null && typeof publisher !== 'function') throw new TypeError('publisher must be a function or null')
    this.messagePublisher = publisher
  }

  getConsoleState() {
    const channels = {}
    const metaConfig = {}
    for (const platform of PLATFORMS) {
      channels[platform] = this.#channel(platform)
      const config = this.state.platforms[platform].config
      metaConfig[platform] = {
        appId: config.appId,
        hasAppSecret: Boolean(config.appSecret),
        hasVerifyToken: Boolean(config.verifyToken),
        callbackUrl: `${this.publicUrl}/admin/meta/callback/${platform}`,
        webhookUrl: `${this.publicUrl}/webhooks/meta/${platform}`
      }
    }
    return {
      channels,
      metaRevision: this.state.revision,
      metaConfig,
      metaUsers: this.state.users
        .filter((user) => this.state.platforms[user.platform].account?.id === user.accountId
          && this.#effectiveStatus(user.platform) === 'connected')
        .map((user) => this.#publicUser(user)),
      metaConversations: [
        ...this.listChats({ platform: 'instagram', limit: 500 }),
        ...this.listChats({ platform: 'facebook', limit: 500 })
      ].sort((left, right) => right.lastTimestamp - left.lastTimestamp).slice(0, 500)
    }
  }

  getStatus(platform) {
    return this.#channel(platformName(platform))
  }

  async updateConsoleSettings({ revision, action, platform, ...params } = {}) {
    return this.#serialize(async () => {
      this.#requireReady()
      platformName(platform)
      if (revision !== this.state.revision) throw bridgeError('Meta settings changed; reload and try again', 409, 'ECONFLICT')
      const candidate = structuredClone(this.state)
      switch (action) {
        case 'save-config': this.#saveConfig(candidate, platform, params); break
        case 'select-account': await this.#selectAccount(candidate, platform, params.accountId); break
        case 'set-replies': this.#setReplies(candidate, platform, params.enabled); break
        case 'disconnect': this.#disconnect(candidate, platform); break
        case 'save-user': this.#saveUser(candidate, platform, params); break
        case 'bind-owner': this.#bindOwner(candidate, platform, params); break
        case 'unbind-owner': this.#unbindOwner(candidate, platform, params); break
        case 'delete-user': this.#deleteUser(candidate, platform, params); break
        default: throw bridgeError('Unsupported Meta settings action')
      }
      candidate.revision += 1
      this.#prune(candidate)
      await this.#persist(candidate)
      this.state = candidate
      return this.getConsoleState()
    })
  }

  async beginAuthorization(platform, adminSessionHash) {
    return this.#serialize(async () => {
      this.#requireReady()
      platformName(platform)
      const session = cleanString(adminSessionHash, 'Admin session', 512)
      const current = this.state.platforms[platform]
      if (!configured(current)) throw bridgeError('Meta app configuration is incomplete', 409)
      const candidate = structuredClone(this.state)
      const state = randomBytes(32).toString('base64url')
      const now = this.now()
      candidate.oauth = candidate.oauth.filter((item) => item.expiresAt > now && item.platform !== platform)
      candidate.oauth.push({
        platform,
        stateHash: digest(state),
        sessionHash: digest(session),
        expiresAt: now + OAUTH_TTL_MS
      })
      await this.#persist(candidate)
      this.state = candidate
      const callback = `${this.publicUrl}/admin/meta/callback/${platform}`
      const url = platform === 'instagram'
        ? new URL('https://www.instagram.com/oauth/authorize')
        : new URL('https://www.facebook.com/v26.0/dialog/oauth')
      url.searchParams.set('client_id', current.config.appId)
      url.searchParams.set('redirect_uri', callback)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('state', state)
      url.searchParams.set('scope', platform === 'instagram'
        ? 'instagram_business_basic,instagram_business_manage_messages'
        : 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement')
      return { authorizationUrl: url.toString() }
    })
  }

  async completeAuthorization(platform, { code, state, sessionHash } = {}) {
    return this.#serialize(async () => {
      this.#requireReady()
      platformName(platform)
      const cleanCode = cleanString(code, 'Authorization code', 4096)
      const cleanState = cleanString(state, 'OAuth state', 512)
      const cleanSession = cleanString(sessionHash, 'Admin session', 512)
      const stateHash = digest(cleanState)
      const index = this.state.oauth.findIndex((item) => item.platform === platform && equalText(item.stateHash, stateHash))
      if (index < 0) throw bridgeError('OAuth state is invalid or already used', 403, 'EOAUTH')
      const pending = this.state.oauth[index]
      const consumed = structuredClone(this.state)
      consumed.oauth.splice(index, 1)
      await this.#persist(consumed)
      this.state = consumed
      if (pending.expiresAt <= this.now() || !equalText(pending.sessionHash, digest(cleanSession))) {
        throw bridgeError('OAuth state is invalid or expired', 403, 'EOAUTH')
      }
      const authorized = structuredClone(this.state)
      let result
      try {
        result = platform === 'instagram'
          ? await this.#authorizeInstagram(authorized, cleanCode)
          : await this.#authorizeFacebook(authorized, cleanCode)
      } catch (error) {
        const failed = structuredClone(this.state)
        const current = failed.platforms[platform]
        current.status = error?.status === 401 ? 'expired' : 'error'
        current.autoReplyEnabled = false
        current.lastError = 'Meta authorization failed'
        failed.revision += 1
        await this.#persist(failed)
        this.state = failed
        throw error
      }
      authorized.revision += 1
      await this.#persist(authorized)
      this.state = authorized
      return { assets: result.map(publicAccount), ...this.getConsoleState() }
    })
  }

  verifyWebhook(platform, searchParams) {
    this.#requireReady()
    platformName(platform)
    if (!(searchParams instanceof URLSearchParams)) throw bridgeError('Webhook query is invalid')
    const expected = this.state.platforms[platform].config.verifyToken
    const supplied = searchParams.get('hub.verify_token')
    const challenge = searchParams.get('hub.challenge')
    if (!expected || searchParams.get('hub.mode') !== 'subscribe' || !equalText(expected, supplied) || !challenge || challenge.length > 4096) {
      throw bridgeError('Webhook verification failed', 403, 'EVERIFY')
    }
    return challenge
  }

  async ingestWebhook(platform, rawBuffer, signature) {
    return this.#serialize(async () => {
      this.#requireReady()
      platformName(platform)
      if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0 || rawBuffer.length > MAX_WEBHOOK_BYTES) {
        throw bridgeError('Webhook body is invalid', 413, 'EWEBHOOK')
      }
      const secret = this.state.platforms[platform].config.appSecret
      if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
        throw bridgeError('Webhook signature is invalid', 403, 'ESIGNATURE')
      }
      const expected = `sha256=${createHmac('sha256', secret).update(rawBuffer).digest('hex')}`
      if (!equalText(expected.toLowerCase(), signature.toLowerCase())) throw bridgeError('Webhook signature is invalid', 403, 'ESIGNATURE')
      let payload
      try { payload = JSON.parse(rawBuffer.toString('utf8')) } catch { throw bridgeError('Webhook JSON is invalid') }
      const expectedObject = platform === 'instagram' ? 'instagram' : 'page'
      if (!isRecord(payload) || payload.object !== expectedObject || !Array.isArray(payload.entry)) return { stored: 0, emitted: 0 }
      const current = this.state.platforms[platform]
      if (this.#effectiveStatus(platform) !== 'connected' || !current.account) return { stored: 0, emitted: 0 }
      const candidate = structuredClone(this.state)
      const candidatePlatform = candidate.platforms[platform]
      const now = this.now()
      let stored = 0
      const processed = []
      const processedKeys = new Set()
      for (const entry of payload.entry.slice(0, 100)) {
        if (!isRecord(entry) || String(entry.id) !== candidatePlatform.account.id || !Array.isArray(entry.messaging)) continue
        for (const event of entry.messaging.slice(0, 100)) {
          const incoming = this.#incomingMessage(platform, candidatePlatform.account.id, event, now)
          if (!incoming) continue
          const dedupeKey = `${platform}:${candidatePlatform.account.id}:${incoming.id}`
          if (processedKeys.has(dedupeKey) || candidate.dedupe.some((item) => item.key === dedupeKey)) continue
          processedKeys.add(dedupeKey)
          let message = candidate.messages.find((item) => item.platform === platform
            && item.accountId === incoming.accountId && item.chatId === incoming.chatId && item.id === incoming.id)
          if (!message) {
            candidate.messages.push(incoming)
            message = incoming
            stored += 1
          }
          const eligible = candidatePlatform.autoReplyEnabled && message.timestamp > (candidatePlatform.cutoff ?? now)
            && message.timestamp <= now + 5 * 60 * 1000 && now - message.timestamp < REPLY_WINDOW_MS
          processed.push({ dedupeKey, message, eligible })
        }
      }
      this.#prune(candidate)
      if (stored > 0) {
        await this.#persist(candidate)
        this.state = candidate
      }
      for (const item of processed) {
        if (item.eligible) await this.#publishMessage(this.#publicMessage(item.message))
      }
      if (processed.length > 0) {
        const acknowledged = structuredClone(this.state)
        for (const item of processed) {
          if (!acknowledged.dedupe.some((entry) => entry.key === item.dedupeKey)) {
            acknowledged.dedupe.push({ key: item.dedupeKey, at: now })
          }
        }
        this.#prune(acknowledged)
        await this.#persist(acknowledged)
        this.state = acknowledged
      }
      return { stored, emitted: processed.filter((item) => item.eligible).length }
    })
  }

  getMessages({ platform, chatId, limit = 30 } = {}) {
    platformName(platform)
    const cleanChat = this.#chatId(platform, chatId)
    const boundedLimit = this.#limit(limit, 30, 100)
    const current = this.state.platforms[platform]
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account
      || !cleanChat.startsWith(`${platform}:${current.account.id}:`)) return []
    return this.state.messages
      .filter((message) => message.platform === platform && message.chatId === cleanChat)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, boundedLimit)
      .map((message) => this.#publicMessage(message))
  }

  getPendingReplies({ platform, after, limit = 20 } = {}) {
    platformName(platform)
    const cursor = after === undefined || after === null ? 0 : after
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw bridgeError('after is invalid')
    const boundedLimit = this.#limit(limit, 20, 100)
    const current = this.state.platforms[platform]
    const now = this.now()
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account || !current.autoReplyEnabled) return []
    return this.state.messages
      .filter((message) => message.platform === platform && !message.fromMe
        && message.accountId === current.account.id
        && message.timestamp > cursor && message.timestamp > (current.cutoff ?? now)
        && now - message.timestamp < REPLY_WINDOW_MS
        && !this.state.receipts.some((receipt) => receipt.platform === platform
          && receipt.accountId === message.accountId && receipt.chatId === message.chatId
          && receipt.sourceMessageId === message.id))
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, boundedLimit)
      .map((message) => this.#publicMessage(message))
  }

  canDeliver(message) {
    if (!this.started || !this.valid || !isRecord(message)) return false
    let platform
    try { platform = platformName(message.platform) } catch { return false }
    const current = this.state.platforms[platform]
    const now = this.now()
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account || !current.autoReplyEnabled) return false
    if (message.accountId !== current.account.id || typeof message.chatId !== 'string'
      || typeof message.id !== 'string' || typeof message.senderId !== 'string'
      || message.fromMe !== false || message.replyAllowed !== true) return false
    const source = this.state.messages.find((item) => item.platform === platform && item.accountId === message.accountId
      && item.chatId === message.chatId && item.id === message.id && item.senderId === message.senderId && !item.fromMe)
    const originalTimestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : message.timestamp
    if (!source || originalTimestamp !== source.timestamp || message.text !== source.text || message.type !== source.type
      || (message.mediaType ?? null) !== source.mediaType || JSON.stringify(message.media ?? null) !== JSON.stringify(source.media)
      || source.timestamp <= (current.cutoff ?? now)
      || source.timestamp > now + 5 * 60 * 1000 || now - source.timestamp >= REPLY_WINDOW_MS) return false
    const fresh = this.#permission(platform, source.accountId, source.senderId)
    const original = message.permission
    if (!isRecord(original)) return false
    return original.mode === fresh.mode
      && original.actorLevel === fresh.actorLevel
      && original.roomLevel === fresh.roomLevel
      && original.effectiveLevel === fresh.effectiveLevel
      && original.audience === fresh.audience
      && original.actorIsOwner === fresh.actorIsOwner
      && original.policyValid === fresh.policyValid
      && original.privateDataAllowed === fresh.privateDataAllowed
      && original.managePermissionsAllowed === fresh.managePermissionsAllowed
  }

  getMediaDescriptor({ platform, chatId, messageId } = {}) {
    platformName(platform)
    const cleanChat = this.#chatId(platform, chatId)
    const cleanId = cleanString(messageId, 'Message ID', 500)
    const current = this.state.platforms[platform]
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account
      || !cleanChat.startsWith(`${platform}:${current.account.id}:`)) return null
    const message = this.state.messages.find((item) => item.platform === platform && item.chatId === cleanChat && item.id === cleanId)
    return message?.descriptor ? structuredClone(message.descriptor) : null
  }

  listChats({ platform, limit = 100 } = {}) {
    platformName(platform)
    const boundedLimit = this.#limit(limit, 100, 500)
    const current = this.state.platforms[platform]
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account) return []
    const chats = new Map()
    for (const message of this.state.messages) {
      if (message.platform !== platform || message.accountId !== current.account.id) continue
      const existing = chats.get(message.chatId)
      if (!existing || message.timestamp > existing.lastTimestamp) {
        const user = this.#user(platform, message.accountId, message.senderId)
        chats.set(message.chatId, {
          platform,
          accountId: message.accountId,
          chatId: message.chatId,
          senderId: message.senderId,
          displayName: user?.displayName ?? message.senderId,
          lastMessage: message.text,
          lastTimestamp: message.timestamp,
          messageCount: (existing?.messageCount ?? 0) + 1
        })
      } else {
        existing.messageCount += 1
      }
    }
    return [...chats.values()].sort((left, right) => right.lastTimestamp - left.lastTimestamp).slice(0, boundedLimit)
  }

  async sendText({ platform, chatId, text, idempotencyKey, sourceMessageId } = {}) {
    const cleanText = cleanString(text, 'Message text', 2000)
    return this.#send({ platform, chatId, idempotencyKey, sourceMessageId, type: 'text', text: cleanText })
  }

  async sendImage({ platform, chatId, imageUrl, imageDigest, idempotencyKey, sourceMessageId } = {}) {
    const cleanDigest = imageDigest === undefined
      ? null
      : cleanString(imageDigest, 'Image digest', 64).toLowerCase()
    if (cleanDigest !== null && !/^[a-f0-9]{64}$/.test(cleanDigest)) throw bridgeError('Image digest is invalid')
    return this.#send({
      platform,
      chatId,
      idempotencyKey,
      sourceMessageId,
      type: 'image',
      imageUrl: this.#imageUrl(imageUrl),
      imageDigest: cleanDigest
    })
  }

  async #send(input) {
    return this.#serialize(async () => {
      this.#requireReady()
      const platform = platformName(input.platform)
      const chatId = this.#chatId(platform, input.chatId)
      const key = cleanString(input.idempotencyKey, 'Idempotency key', 200)
      const sourceMessageId = cleanString(input.sourceMessageId, 'Source message ID', 500)
      const current = this.state.platforms[platform]
      const senderId = chatId.split(':')[2]
      const accountId = chatId.split(':')[1]
      const receiptKey = `${platform}:${accountId}:${chatId}:${key}`
      const payloadHash = digest(JSON.stringify({
        type: input.type,
        text: input.text ?? null,
        image: input.type === 'image' ? (input.imageDigest ?? input.imageUrl) : null,
        sourceMessageId
      }))
      const existing = this.state.receipts.find((receipt) => receipt.key === receiptKey)
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw bridgeError('Idempotency key was reused with different content', 409, 'EIDEMPOTENCY')
        if (existing.status === 'sent') return { messageId: existing.messageId }
        throw bridgeError('Previous send outcome is unknown; manual review is required', 409, 'EUNKNOWN')
      }
      const source = this.state.messages.find((message) => message.platform === platform && message.chatId === chatId
        && message.id === sourceMessageId && !message.fromMe)
      this.#assertSendAllowed(platform, current, source, senderId)
      const receipt = {
        key: receiptKey,
        payloadHash,
        status: 'inflight',
        messageId: null,
        updatedAt: this.now(),
        platform,
        accountId,
        chatId,
        sourceMessageId
      }
      const inflight = structuredClone(this.state)
      inflight.receipts.push(receipt)
      this.#prune(inflight)
      await this.#persist(inflight)
      this.state = inflight
      const committedCurrent = this.state.platforms[platform]
      this.#assertSendAllowed(platform, committedCurrent, source, senderId)
      const requestBody = {
        recipient: { id: senderId },
        message: input.type === 'text'
          ? { text: input.text }
          : { attachment: { type: 'image', payload: { url: input.imageUrl, is_reusable: true } } }
      }
      if (platform === 'facebook') requestBody.messaging_type = 'RESPONSE'
      let response
      try {
        const host = platform === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'
        response = await this.#request(`https://${host}/v26.0/${committedCurrent.account.id}/messages`, {
          method: 'POST',
          token: committedCurrent.accessToken,
          json: requestBody
        })
      } catch (error) {
        const failed = structuredClone(this.state)
        const failedReceipt = failed.receipts.find((item) => item.key === receiptKey)
        failedReceipt.status = 'unknown'
        failedReceipt.updatedAt = this.now()
        const failedPlatform = failed.platforms[platform]
        if (error?.status === 401) {
          failedPlatform.status = 'expired'
          failedPlatform.autoReplyEnabled = false
          failedPlatform.lastError = 'Meta authorization expired'
          failed.revision += 1
        } else {
          failedPlatform.lastError = 'Meta send failed'
        }
        await this.#persist(failed)
        this.state = failed
        throw error
      }
      const messageId = typeof response.message_id === 'string' ? response.message_id : null
      if (!messageId) {
        const failed = structuredClone(this.state)
        const failedReceipt = failed.receipts.find((item) => item.key === receiptKey)
        failedReceipt.status = 'unknown'
        failedReceipt.updatedAt = this.now()
        failed.platforms[platform].lastError = 'Meta send failed'
        await this.#persist(failed)
        this.state = failed
        throw bridgeError('Meta send result is incomplete', 502, 'EPROVIDER')
      }
      const sent = structuredClone(this.state)
      const sentReceipt = sent.receipts.find((item) => item.key === receiptKey)
      sentReceipt.status = 'sent'
      sentReceipt.messageId = messageId.slice(0, 500)
      sentReceipt.updatedAt = this.now()
      sent.platforms[platform].lastError = null
      sent.messages.push({
        platform,
        accountId: committedCurrent.account.id,
        chatId,
        id: sentReceipt.messageId,
        senderId,
        text: input.text ?? null,
        timestamp: this.now(),
        storedAt: this.now(),
        fromMe: true,
        type: input.type === 'text' ? 'text' : 'media',
        mediaType: input.type === 'image' ? 'image' : null,
        media: input.type === 'image' ? { mimetype: null, fileName: null } : null,
        descriptor: null,
        sourceMessageId
      })
      this.#prune(sent)
      await this.#persist(sent)
      this.state = sent
      return { messageId: sentReceipt.messageId }
    })
  }

  #saveConfig(state, platform, { appId, appSecret, verifyToken }) {
    const current = state.platforms[platform]
    const nextAppId = cleanString(appId, 'App ID', 200, { allowEmpty: true })
    if (nextAppId && !META_ID.test(nextAppId)) throw bridgeError('App ID is invalid')
    const nextSecret = typeof appSecret === 'string' && appSecret.length === 0
      ? current.config.appSecret
      : cleanString(appSecret, 'App secret', 4096, { optional: true }) ?? current.config.appSecret
    const nextVerify = typeof verifyToken === 'string' && verifyToken.length === 0
      ? current.config.verifyToken
      : cleanString(verifyToken, 'Verify token', 4096, { optional: true }) ?? current.config.verifyToken
    const credentialsChanged = current.config.appId !== nextAppId || current.config.appSecret !== nextSecret
    current.config = { appId: nextAppId, appSecret: nextSecret, verifyToken: nextVerify }
    if (credentialsChanged) {
      this.#clearConnection(current)
      current.status = configured(current) ? 'ready_to_authorize' : 'not_configured'
    } else if (!configured(current)) {
      current.status = 'not_configured'
    } else if (!['connected', 'select_account', 'expired'].includes(current.status)) {
      current.status = 'ready_to_authorize'
    }
    current.lastError = null
  }

  async #selectAccount(state, platform, accountId) {
    if (platform !== 'facebook') throw bridgeError('Account selection is not available for this platform')
    const current = state.platforms[platform]
    const cleanId = cleanMetaId(accountId, 'Account ID')
    const asset = current.assets.find((item) => item.id === cleanId)
    if (!asset) throw bridgeError('Selected Page is unavailable', 404)
    if (!asset.accessToken) throw bridgeError('Reauthorize Facebook before selecting this Page', 409)
    let profile
    try {
      profile = await this.#request(`https://graph.facebook.com/v26.0/${cleanId}?fields=id,name`, { token: asset.accessToken })
      if (String(profile.id) !== cleanId || typeof profile.name !== 'string') throw bridgeError('Selected Page could not be verified', 502)
      await this.#request(`https://graph.facebook.com/v26.0/${cleanId}/subscribed_apps`, {
        method: 'POST', token: asset.accessToken, form: { subscribed_fields: 'messages,messaging_postbacks' }
      })
    } catch (error) { throw error }
    current.account = { id: cleanId, name: profile.name.slice(0, 200) }
    current.accessToken = asset.accessToken
    current.tokenExpiresAt = asset.tokenExpiresAt
    current.assets = current.assets.map((item) => item.id === cleanId ? item : { ...item, accessToken: null })
    current.status = 'connected'
    current.autoReplyEnabled = false
    current.cutoff = this.now()
    current.lastError = null
  }

  #setReplies(state, platform, enabled) {
    if (typeof enabled !== 'boolean') throw bridgeError('enabled must be a boolean')
    const current = state.platforms[platform]
    if (this.#effectiveStatus(platform, state) !== 'connected') throw bridgeError('Meta account is not connected', 409)
    if (enabled && !current.autoReplyEnabled) current.cutoff = this.now()
    current.autoReplyEnabled = enabled
  }

  #disconnect(state, platform) {
    const current = state.platforms[platform]
    this.#clearConnection(current)
    current.status = configured(current) ? 'ready_to_authorize' : 'not_configured'
    current.cutoff = this.now()
    current.lastError = null
    state.oauth = state.oauth.filter((item) => item.platform !== platform)
  }

  #saveUser(state, platform, { accountId, senderId, displayName, level }) {
    const current = this.#connectedAccount(platform, state)
    this.#assertAccountScope(current, accountId)
    const cleanSender = cleanMetaId(senderId, 'Sender ID')
    const name = cleanString(displayName, 'Display name', 100)
    if (!LEVELS.has(level)) throw bridgeError('User level must be L2 to L5')
    if (!this.#observed(platform, current.id, cleanSender, state)) throw bridgeError('Sender has not been observed for this account', 404)
    const existing = this.#user(platform, current.id, cleanSender, state)
    if (existing) Object.assign(existing, { displayName: name, level })
    else state.users.push({ platform, accountId: current.id, senderId: cleanSender, displayName: name, level, ownerId: null })
  }

  #bindOwner(state, platform, { accountId, senderId, ownerId }) {
    const current = this.#connectedAccount(platform, state)
    this.#assertAccountScope(current, accountId)
    const cleanSender = cleanMetaId(senderId, 'Sender ID')
    const cleanOwner = cleanString(ownerId, 'Owner ID', 256)
    if (!this.#ownerSet().has(cleanOwner)) throw bridgeError('Owner ID is not an active owner', 403)
    if (!this.#observed(platform, current.id, cleanSender, state)) throw bridgeError('Sender has not been observed for this account', 404)
    let user = this.#user(platform, current.id, cleanSender, state)
    if (!user) {
      user = { platform, accountId: current.id, senderId: cleanSender, displayName: cleanSender, level: 'L5', ownerId: null }
      state.users.push(user)
    }
    user.ownerId = cleanOwner
  }

  #unbindOwner(state, platform, { accountId, senderId }) {
    const current = this.#connectedAccount(platform, state)
    this.#assertAccountScope(current, accountId)
    const cleanSender = cleanMetaId(senderId, 'Sender ID')
    const user = this.#user(platform, current.id, cleanSender, state)
    if (!user) throw bridgeError('User is unavailable', 404)
    user.ownerId = null
  }

  #deleteUser(state, platform, { accountId, senderId }) {
    const current = this.#connectedAccount(platform, state)
    this.#assertAccountScope(current, accountId)
    const cleanSender = cleanMetaId(senderId, 'Sender ID')
    const index = state.users.findIndex((user) => user.platform === platform && user.accountId === current.id && user.senderId === cleanSender)
    if (index < 0) return
    if (state.users[index].ownerId !== null) throw bridgeError('Unbind the owner before deleting this user', 409)
    state.users.splice(index, 1)
  }

  async #authorizeInstagram(state, code) {
    const platform = state.platforms.instagram
    const callback = `${this.publicUrl}/admin/meta/callback/instagram`
    const short = await this.#request('https://api.instagram.com/oauth/access_token', {
      method: 'POST', form: {
        client_id: platform.config.appId,
        client_secret: platform.config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: callback,
        code
      }
    })
    if (typeof short.access_token !== 'string') throw bridgeError('Instagram authorization result is incomplete', 502)
    const exchangeUrl = new URL('https://graph.instagram.com/access_token')
    exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token')
    exchangeUrl.searchParams.set('client_secret', platform.config.appSecret)
    exchangeUrl.searchParams.set('access_token', short.access_token)
    const long = await this.#request(exchangeUrl)
    if (typeof long.access_token !== 'string') throw bridgeError('Instagram token exchange failed', 502)
    const profile = await this.#request('https://graph.instagram.com/me?fields=id,user_id,username', { token: long.access_token })
    const accountId = String(profile.user_id || profile.id || '')
    if (!META_ID.test(accountId)) throw bridgeError('Instagram account could not be verified', 502)
    await this.#request(`https://graph.instagram.com/v26.0/${accountId}/subscribed_apps`, {
      method: 'POST', token: long.access_token, form: { subscribed_fields: 'messages,messaging_postbacks' }
    })
    if (!Number.isFinite(long.expires_in) || long.expires_in <= 0) throw bridgeError('Instagram token expiry is unavailable', 502)
    const expiresAt = this.now() + Math.trunc(long.expires_in * 1000)
    const asset = {
      id: accountId,
      name: typeof profile.username === 'string' ? profile.username.slice(0, 200) : `Instagram ${accountId}`,
      ...(typeof profile.username === 'string' ? { username: profile.username.slice(0, 200) } : {}),
      accessToken: long.access_token,
      tokenExpiresAt: expiresAt
    }
    platform.assets = [asset]
    platform.account = publicAccount(asset)
    platform.accessToken = long.access_token
    platform.tokenExpiresAt = expiresAt
    platform.status = 'connected'
    platform.autoReplyEnabled = false
    platform.cutoff = this.now()
    platform.lastError = null
    return [asset]
  }

  async #authorizeFacebook(state, code) {
    const platform = state.platforms.facebook
    const callback = `${this.publicUrl}/admin/meta/callback/facebook`
    const token = await this.#request('https://graph.facebook.com/v26.0/oauth/access_token', {
      method: 'POST', form: {
        client_id: platform.config.appId,
        client_secret: platform.config.appSecret,
        redirect_uri: callback,
        code
      }
    })
    if (typeof token.access_token !== 'string') throw bridgeError('Facebook authorization result is incomplete', 502)
    const long = await this.#request('https://graph.facebook.com/v26.0/oauth/access_token', {
      method: 'POST', form: {
        grant_type: 'fb_exchange_token',
        client_id: platform.config.appId,
        client_secret: platform.config.appSecret,
        fb_exchange_token: token.access_token
      }
    })
    if (typeof long.access_token !== 'string' || !Number.isFinite(long.expires_in) || long.expires_in <= 0) {
      throw bridgeError('Facebook long-lived authorization is unavailable', 502)
    }
    const expiresAt = this.now() + Math.trunc(long.expires_in * 1000)
    const pages = await this.#request('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token&limit=100', {
      token: long.access_token
    })
    if (!Array.isArray(pages.data)) throw bridgeError('Facebook Page list is unavailable', 502)
    const assets = pages.data.filter((page) => isRecord(page) && META_ID.test(String(page.id))
      && typeof page.name === 'string' && typeof page.access_token === 'string').slice(0, 100).map((page) => ({
      id: String(page.id),
      name: page.name.slice(0, 200),
      accessToken: page.access_token,
      tokenExpiresAt: expiresAt
    }))
    platform.assets = assets
    platform.account = null
    platform.accessToken = null
    platform.tokenExpiresAt = null
    platform.status = 'select_account'
    platform.autoReplyEnabled = false
    platform.cutoff = this.now()
    platform.lastError = assets.length > 0 ? null : 'No manageable Facebook Pages were returned'
    return assets
  }

  #incomingMessage(platform, accountId, event, storedAt) {
    if (!isRecord(event) || !isRecord(event.sender) || !isRecord(event.recipient) || !isRecord(event.message)) return null
    if (event.read || event.delivery || event.message.is_echo === true) return null
    const senderId = String(event.sender.id || '')
    const recipientId = String(event.recipient.id || '')
    const id = String(event.message.mid || '')
    const timestamp = safeTimestamp(event.timestamp)
    if (!META_ID.test(senderId) || senderId === accountId || recipientId !== accountId || !id || id.length > 500 || timestamp === null) return null
    const attachment = Array.isArray(event.message.attachments) ? attachmentInfo(event.message.attachments[0], id) : null
    const text = boundedText(event.message.text)
    if (!attachment && (text === null || text.length === 0)) return null
    return {
      platform,
      accountId,
      chatId: `${platform}:${accountId}:${senderId}`,
      id,
      senderId,
      text,
      timestamp,
      storedAt,
      fromMe: false,
      type: attachment ? 'media' : 'text',
      mediaType: attachment?.mediaType ?? null,
      media: attachment?.media ?? null,
      descriptor: attachment?.descriptor ?? null,
      sourceMessageId: null
    }
  }

  #publicMessage(message) {
    return {
      platform: message.platform,
      accountId: message.accountId,
      chatId: message.chatId,
      id: message.id,
      senderId: message.senderId,
      text: message.text,
      timestamp: message.timestamp,
      fromMe: message.fromMe,
      type: message.type,
      ...(message.mediaType ? { mediaType: message.mediaType } : {}),
      ...(message.media ? { media: structuredClone(message.media) } : {}),
      permission: this.#permission(message.platform, message.accountId, message.senderId, !message.fromMe),
      replyAllowed: !message.fromMe
    }
  }

  async #publishMessage(message) {
    if (this.messagePublisher) {
      await this.messagePublisher(message)
      return
    }
    const listeners = this.rawListeners('message')
    await Promise.all(listeners.map((listener) => listener.call(this, message)))
  }

  #permission(platform, accountId, senderId, incoming = true) {
    const user = this.#user(platform, accountId, senderId)
    const actorIsOwner = incoming && Boolean(user?.ownerId && this.#ownerSet().has(user.ownerId))
    const actorLevel = incoming ? (actorIsOwner ? 'L1' : (user?.level ?? 'L5')) : 'L5'
    return {
      mode: 'rules_only',
      actorLevel,
      roomLevel: actorLevel,
      effectiveLevel: actorLevel,
      audience: 'private',
      actorIsOwner,
      policyValid: this.valid,
      privateDataAllowed: actorIsOwner && this.valid,
      managePermissionsAllowed: actorIsOwner && this.valid
    }
  }

  #publicUser(user) {
    const permission = this.#permission(user.platform, user.accountId, user.senderId)
    return {
      platform: user.platform,
      accountId: user.accountId,
      senderId: user.senderId,
      displayName: user.displayName,
      level: permission.actorLevel,
      ownerId: permission.actorIsOwner ? user.ownerId : null,
      actorIsOwner: permission.actorIsOwner
    }
  }

  #channel(platform) {
    const current = this.state.platforms[platform]
    return {
      status: this.#effectiveStatus(platform),
      account: publicAccount(current.account),
      autoReplyEnabled: current.autoReplyEnabled,
      assets: current.assets.map(publicAccount),
      capabilities: { direct: true, groups: false, text: true, image: true, quote: false },
      ...(current.tokenExpiresAt === null ? {} : { tokenExpiresAt: current.tokenExpiresAt }),
      lastError: current.lastError
    }
  }

  #effectiveStatus(platform, state = this.state) {
    const current = state.platforms[platform]
    if (!this.valid) return 'error'
    if (current.status === 'connected' && current.tokenExpiresAt !== null && current.tokenExpiresAt <= this.now()) return 'expired'
    return current.status
  }

  #assertSendAllowed(platform, current, source, senderId) {
    const now = this.now()
    if (this.#effectiveStatus(platform) !== 'connected' || !current.account || !current.accessToken) throw bridgeError('Meta account is not connected', 409)
    if (!current.autoReplyEnabled) throw bridgeError('Automatic replies are paused', 409)
    if (!source || source.senderId !== senderId || source.accountId !== current.account.id) throw bridgeError('Source message is unavailable', 404)
    if (source.timestamp <= (current.cutoff ?? now)) throw bridgeError('Source message predates the current reply session', 409)
    if (now - source.timestamp >= REPLY_WINDOW_MS || source.timestamp > now + 5 * 60 * 1000) throw bridgeError('The standard reply window has expired', 409)
    this.#permission(platform, current.account.id, senderId)
  }

  #connectedAccount(platform, state = this.state) {
    const current = state.platforms[platform]
    if (this.#effectiveStatus(platform, state) !== 'connected' || !current.account) throw bridgeError('Meta account is not connected', 409)
    return current.account
  }

  #assertAccountScope(current, accountId) {
    if (accountId !== undefined && cleanMetaId(accountId, 'Account ID') !== current.id) {
      throw bridgeError('Account scope does not match the connected account', 409)
    }
  }

  #observed(platform, accountId, senderId, state = this.state) {
    return state.messages.some((message) => message.platform === platform && message.accountId === accountId
      && message.senderId === senderId && !message.fromMe)
  }

  #user(platform, accountId, senderId, state = this.state) {
    return state.users.find((user) => user.platform === platform && user.accountId === accountId && user.senderId === senderId)
  }

  #ownerSet() {
    let values
    try { values = this.ownerIds() } catch { return new Set() }
    return new Set(values instanceof Set || Array.isArray(values) ? values : [])
  }

  #chatId(platform, value) {
    if (typeof value !== 'string') throw bridgeError('Chat ID is invalid')
    const match = /^(instagram|facebook):(\d{1,64}):(\d{1,64})$/.exec(value)
    if (!match || match[1] !== platform) throw bridgeError('Chat ID is invalid')
    return value
  }

  #imageUrl(value) {
    let parsed
    try { parsed = new URL(value) } catch { throw bridgeError('Image URL is invalid') }
    const origin = new URL(this.publicUrl)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin.origin || !/^\/media\/[A-Za-z0-9_-]{16,512}$/.test(parsed.pathname) || parsed.search || parsed.hash) {
      throw bridgeError('Image URL is not an approved media capability')
    }
    return parsed.toString()
  }

  #limit(value, fallback, maximum) {
    const result = value === undefined ? fallback : value
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw bridgeError('limit is invalid')
    return result
  }

  #clearConnection(platform) {
    platform.account = null
    platform.assets = []
    platform.autoReplyEnabled = false
    platform.accessToken = null
    platform.tokenExpiresAt = null
  }

  #requireReady() {
    if (!this.started) throw bridgeError('Meta bridge is not started', 503)
    if (!this.valid) throw bridgeError('Meta state is unavailable', 503)
  }

  #serialize(callback) {
    const result = this.mutationChain.then(callback, callback)
    this.mutationChain = result.then(() => {}, () => {})
    return result
  }

  #prune(state = this.state) {
    const threshold = this.now() - RETENTION_MS
    state.oauth = state.oauth.filter((item) => item.expiresAt > this.now()).slice(-20)
    state.messages = state.messages.filter((item) => item.storedAt >= threshold).slice(-MAX_MESSAGES)
    state.dedupe = state.dedupe.filter((item) => item.at >= threshold).slice(-MAX_DEDUPE)
    state.receipts = state.receipts.filter((item) => item.updatedAt >= threshold).slice(-MAX_RECEIPTS)
  }

  async #load() {
    let handle
    try {
      handle = await open(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileStat = await handle.stat()
      if (!fileStat.isFile() || fileStat.size > MAX_STATE_BYTES || (fileStat.mode & 0o777) !== 0o600) throw bridgeError('Unsafe Meta state', 503)
      const state = JSON.parse(await handle.readFile('utf8'))
      if (!validateState(state)) throw bridgeError('Invalid Meta state', 503)
      return state
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const state = defaultState()
      this.state = state
      await this.#persist()
      return state
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async #persist(state = this.state) {
    const data = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw bridgeError('Meta state exceeds its storage limit', 413)
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

  async #request(input, { method = 'GET', token = null, form = null, json = null } = {}) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname)) {
      throw bridgeError('Meta request target is not allowed', 500)
    }
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    let body
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    } else if (json) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    let response
    let bytes
    try {
      response = await this.fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal })
      const declared = Number.parseInt(response.headers?.get?.('content-length') || '', 10)
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw bridgeError('Meta response is too large', 502)
      const chunks = []
      let size = 0
      if (response.body?.getReader) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {})
            throw bridgeError('Meta response is too large', 502)
          }
          chunks.push(Buffer.from(value))
        }
        bytes = Buffer.concat(chunks, size)
      } else {
        bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > MAX_RESPONSE_BYTES) throw bridgeError('Meta response is too large', 502)
      }
    } catch (error) {
      if (error?.code === 'EMETA') throw error
      throw bridgeError(response ? 'Meta response could not be read' : 'Meta request failed', 502, 'EPROVIDER')
    } finally {
      clearTimeout(timer)
    }
    let parsed = {}
    if (bytes.length > 0) {
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw bridgeError('Meta response is invalid', 502) }
    }
    if (!response.ok) {
      const providerCode = Number(parsed.error?.code)
      if (response.status === 401 || providerCode === 190) throw bridgeError('Meta authorization expired', 401, 'EAUTHEXPIRED')
      if (response.status === 403) throw bridgeError('Meta request was forbidden', 403, 'EPROVIDER')
      throw bridgeError('Meta request was rejected', 502, 'EPROVIDER')
    }
    if (!isRecord(parsed)) throw bridgeError('Meta response is invalid', 502)
    return parsed
  }
}
