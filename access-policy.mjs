import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, open, rename, unlink, writeFile } from 'node:fs/promises'

const POLICY_VERSION = 1
const MAX_POLICY_BYTES = 4096
const USER_JID = /^[1-9]\d{4,19}@s\.whatsapp\.net$/
const GROUP_JID = /^[1-9]\d{4,19}(?:-[1-9]\d{4,19})?@g\.us$/
const LID_JID = /^[1-9]\d{4,19}@lid$/
const LEVELS = new Set(['L2', 'L3', 'L4', 'L5'])
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function normalizeTransportJid(value) {
  if (typeof value !== 'string') return null
  const identity = /^([1-9]\d{4,19})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value)
  if (identity) return `${identity[1]}@${identity[2]}`
  return GROUP_JID.test(value) ? value : null
}

function defaultPolicy(valid = true) {
  return {
    valid,
    userLevels: new Map(),
    userProfiles: new Map(),
    roomLevels: new Map(),
    autoReplyEnabled: true,
    groupRepliesAfter: null,
    privateRepliesAfter: null
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLevels(value, type) {
  if (value === undefined) return new Map()
  if (!isRecord(value)) throw new Error('invalid access policy')
  const result = new Map()
  for (const [rawJid, level] of Object.entries(value)) {
    if (RESERVED_KEYS.has(rawJid) || !LEVELS.has(level)) throw new Error('invalid access policy')
    const jid = normalizeTransportJid(rawJid)
    const validType = type === 'user'
      ? jid !== null && (USER_JID.test(jid) || LID_JID.test(jid))
      : jid !== null && GROUP_JID.test(jid)
    if (!validType || result.has(jid)) throw new Error('invalid access policy')
    result.set(jid, level)
  }
  return result
}

function parseProfiles(value, userLevels) {
  if (value === undefined) return new Map()
  if (!isRecord(value)) throw new Error('invalid access policy')
  const result = new Map()
  for (const [rawJid, profile] of Object.entries(value)) {
    if (RESERVED_KEYS.has(rawJid) || !isRecord(profile)) throw new Error('invalid access policy')
    const jid = normalizeTransportJid(rawJid)
    const keys = Object.keys(profile)
    if (
      jid === null
      || !(USER_JID.test(jid) || LID_JID.test(jid))
      || result.has(jid)
      || !userLevels.has(jid)
      || keys.some((key) => RESERVED_KEYS.has(key) || !['displayName', 'instagramUsername'].includes(key))
      || typeof profile.displayName !== 'string'
      || profile.displayName.length < 1
      || profile.displayName.length > 100
      || Buffer.byteLength(profile.displayName) > 512
      || /[\u0000-\u001f\u007f]/.test(profile.displayName)
      || (profile.instagramUsername !== undefined && profile.instagramUsername !== null && (
        typeof profile.instagramUsername !== 'string'
        || profile.instagramUsername.length > 128
        || /[\u0000-\u001f\u007f]/.test(profile.instagramUsername)
      ))
    ) throw new Error('invalid access policy')
    result.set(jid, {
      displayName: profile.displayName,
      instagramUsername: profile.instagramUsername ?? null
    })
  }
  return result
}

export async function loadAccessPolicy(file, ownerIds = new Set()) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const fileStat = await handle.stat()
    if (!fileStat.isFile() || fileStat.size > MAX_POLICY_BYTES || (fileStat.mode & 0o777) !== 0o600) {
      return defaultPolicy(false)
    }
    const parsed = JSON.parse(await handle.readFile('utf8'))
    if (!isRecord(parsed)) return defaultPolicy(false)
    const allowedKeys = new Set([
      'autoReplyEnabled',
      'groupRepliesAfter',
      'privateRepliesAfter',
      'roomLevels',
      'userLevels',
      'userProfiles',
      'version'
    ])
    const keys = Object.keys(parsed)
    const validTimestamp = (value) => value === undefined || (Number.isSafeInteger(value) && value >= 1)
    if (
      keys.some((key) => RESERVED_KEYS.has(key) || !allowedKeys.has(key))
      || parsed.version !== POLICY_VERSION
      || (parsed.autoReplyEnabled !== undefined && typeof parsed.autoReplyEnabled !== 'boolean')
      || !validTimestamp(parsed.groupRepliesAfter)
      || !validTimestamp(parsed.privateRepliesAfter)
    ) return defaultPolicy(false)
    const userLevels = parseLevels(parsed.userLevels, 'user')
    if ([...userLevels.keys()].some((jid) => ownerIds.has(jid))) return defaultPolicy(false)
    return {
      valid: true,
      userLevels,
      userProfiles: parseProfiles(parsed.userProfiles, userLevels),
      roomLevels: parseLevels(parsed.roomLevels, 'room'),
      autoReplyEnabled: parsed.autoReplyEnabled ?? true,
      groupRepliesAfter: parsed.groupRepliesAfter ?? null,
      privateRepliesAfter: parsed.privateRepliesAfter ?? null
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultPolicy()
    return defaultPolicy(false)
  } finally {
    await handle?.close().catch(() => {})
  }
}

function policyDocument(policy) {
  const sortedObject = (map, valueMapper = (value) => value) => Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, valueMapper(value)])
  )
  const document = {
    version: POLICY_VERSION,
    autoReplyEnabled: policy.autoReplyEnabled,
    userLevels: sortedObject(policy.userLevels),
    userProfiles: sortedObject(policy.userProfiles, (profile) => ({
      displayName: profile.displayName,
      ...(profile.instagramUsername === null ? {} : { instagramUsername: profile.instagramUsername })
    })),
    roomLevels: sortedObject(policy.roomLevels)
  }
  if (policy.groupRepliesAfter !== null) document.groupRepliesAfter = policy.groupRepliesAfter
  if (policy.privateRepliesAfter !== null) document.privateRepliesAfter = policy.privateRepliesAfter
  return document
}

export function accessPolicyRevision(policy) {
  return createHash('sha256').update(JSON.stringify(policyDocument(policy))).digest('hex')
}

export async function persistAccessPolicy(file, policy, ownerIds = new Set()) {
  const data = `${JSON.stringify(policyDocument(policy))}\n`
  if (Buffer.byteLength(data) > MAX_POLICY_BYTES) {
    const error = new Error('Access policy exceeds 4096 bytes')
    error.status = 413
    throw error
  }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  const readback = await loadAccessPolicy(file, ownerIds)
  if (!readback.valid) throw new Error('Unable to read back access policy')
  return readback
}

export function permissionForMessage(message, policy, ownerIds) {
  const audience = GROUP_JID.test(message?.chatId) ? 'group' : 'private'
  const incoming = message?.direction === 'incoming' && message?.fromMe === false
  const senderId = incoming ? normalizeTransportJid(message?.senderId) : null
  const actorId = senderId !== null && (
    audience === 'group' || normalizeTransportJid(message?.chatId) === senderId
  ) ? senderId : null
  const actorIsOwner = actorId !== null && ownerIds.has(actorId)
  const actorLevel = actorIsOwner ? 'L1' : (policy.valid && actorId ? policy.userLevels.get(actorId) ?? 'L5' : 'L5')
  const roomLevel = audience === 'group'
    ? (policy.valid ? policy.roomLevels.get(message.chatId) ?? 'L5' : 'L5')
    : (policy.valid ? actorLevel : 'L5')
  const effectiveLevel = policy.valid
    ? `L${Math.max(Number(actorLevel.slice(1)), Number(roomLevel.slice(1)))}`
    : 'L5'
  const privilegedPrivate = policy.valid
    && audience === 'private'
    && incoming
    && actorIsOwner
    && effectiveLevel === 'L1'
  return {
    mode: 'rules_only',
    policyValid: policy.valid,
    actorLevel,
    roomLevel,
    effectiveLevel,
    audience,
    actorIsOwner,
    privateDataAllowed: privilegedPrivate,
    managePermissionsAllowed: privilegedPrivate
  }
}
