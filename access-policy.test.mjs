import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  accessPolicyRevision,
  loadAccessPolicy,
  permissionForMessage,
  persistAccessPolicy
} from './access-policy.mjs'

test('loads missing and explicit policies with normalized transport JIDs', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-access-policy-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerIds = new Set([ownerId])
  const missing = await loadAccessPolicy(join(dataDir, 'missing.json'), ownerIds)
  assert.equal(missing.valid, true)
  assert.equal(missing.groupRepliesAfter, null)

  const file = join(dataDir, 'access-policy.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    userLevels: {
      '85255550000:7@s.whatsapp.net': 'L2'
    },
    userProfiles: {
      '85255550000@s.whatsapp.net': { displayName: 'Alice', instagramUsername: 'alice.note' }
    },
    roomLevels: { '120363123456789012@g.us': 'L4' },
    autoReplyEnabled: false,
    privateRepliesAfter: 1_799_999_999_999,
    groupRepliesAfter: 1_800_000_000_000
  }), { mode: 0o600 })
  const policy = await loadAccessPolicy(file, ownerIds)
  assert.equal(policy.valid, true)
  assert.equal(policy.userLevels.get('85255550000@s.whatsapp.net'), 'L2')
  assert.deepEqual(policy.userProfiles.get('85255550000@s.whatsapp.net'), {
    displayName: 'Alice',
    instagramUsername: 'alice.note'
  })
  assert.equal(policy.roomLevels.get('120363123456789012@g.us'), 'L4')
  assert.equal(policy.autoReplyEnabled, false)
  assert.equal(policy.privateRepliesAfter, 1_799_999_999_999)
  assert.equal(policy.groupRepliesAfter, 1_800_000_000_000)
})

test('fails closed for unsafe files, invalid IDs, unknown fields, and delegated L1', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-access-policy-invalid-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerIds = new Set(['111111111111111@lid'])
  const file = join(dataDir, 'access-policy.json')
  const invalidPolicies = [
    { version: 1, userLevels: { '222222222222222@lid': 'L1' } },
    { version: 1, userLevels: { '111111111111111@lid': 'L1' } },
    { version: 1, userLevels: { '111111111111111@lid': 'L2' } },
    { version: 1, userLevels: { ['__proto__']: 'L2' } },
    { version: 1, userLevels: { 'not-a-jid': 'L2' } },
    { version: 1, roomLevels: { '222222222222222@lid': 'L4' } },
    { version: 1, roomLevels: { '120363123456789012@g.us': 'L1' } },
    { version: 1, userProfiles: { '222222222222222@lid': { displayName: 'orphan' } } },
    {
      version: 1,
      userLevels: { '222222222222222@lid': 'L2' },
      userProfiles: { '222222222222222@lid': { displayName: 'valid', authority: 'owner' } }
    },
    { version: 1, autoReplyEnabled: 'yes' },
    { version: 1, privateRepliesAfter: 0 },
    { version: 1, groupRepliesAfter: 0 },
    { version: 1, extra: true }
  ]
  for (const policy of invalidPolicies) {
    await writeFile(file, JSON.stringify(policy), { mode: 0o600 })
    assert.equal((await loadAccessPolicy(file, ownerIds)).valid, false)
  }

  await writeFile(file, JSON.stringify({ version: 1 }), { mode: 0o600 })
  await chmod(file, 0o644)
  assert.equal((await loadAccessPolicy(file, ownerIds)).valid, false)

  const target = join(dataDir, 'target.json')
  const link = join(dataDir, 'link.json')
  await writeFile(target, JSON.stringify({ version: 1 }), { mode: 0o600 })
  await symlink(target, link)
  assert.equal((await loadAccessPolicy(link, ownerIds)).valid, false)
})

test('persists one bounded policy atomically with mode 0600 and stable revision', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-access-policy-persist-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const file = join(dataDir, 'access-policy.json')
  const policy = {
    valid: true,
    userLevels: new Map([['85255550000@s.whatsapp.net', 'L3']]),
    userProfiles: new Map([['85255550000@s.whatsapp.net', {
      displayName: 'Alice', instagramUsername: 'alice.note'
    }]]),
    roomLevels: new Map([['120363123456789012@g.us', 'L4']]),
    autoReplyEnabled: false,
    groupRepliesAfter: 1_800_000_000_000,
    privateRepliesAfter: 1_800_000_000_001
  }
  const saved = await persistAccessPolicy(file, policy)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dataDir), ['access-policy.json'])
  assert.equal(saved.valid, true)
  assert.equal(saved.userLevels.get('85255550000@s.whatsapp.net'), 'L3')
  assert.equal(saved.userProfiles.get('85255550000@s.whatsapp.net').displayName, 'Alice')
  assert.equal(saved.autoReplyEnabled, false)
  assert.equal(accessPolicyRevision(saved), accessPolicyRevision(policy))
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.userProfiles['85255550000@s.whatsapp.net'].instagramUsername, 'alice.note')
  const beforeOversizedWrite = await readFile(file, 'utf8')
  const oversized = {
    ...policy,
    userProfiles: new Map([['85255550000@s.whatsapp.net', {
      displayName: 'Alice', instagramUsername: 'x'.repeat(5000)
    }]])
  }
  await assert.rejects(persistAccessPolicy(file, oversized), (error) => error.status === 413)
  assert.equal(await readFile(file, 'utf8'), beforeOversizedWrite)
  assert.deepEqual(await readdir(dataDir), ['access-policy.json'])
})

test('computes owner, group, configured user, outgoing, and invalid-policy permissions', () => {
  const ownerId = '111111111111111@lid'
  const otherId = '222222222222222@lid'
  const groupId = '120363123456789012@g.us'
  const ownerIds = new Set([ownerId])
  const policy = {
    valid: true,
    userLevels: new Map([[otherId, 'L2']]),
    roomLevels: new Map([[groupId, 'L4']]),
    groupRepliesAfter: null
  }
  const ownerDirect = permissionForMessage({
    chatId: ownerId, senderId: ownerId, direction: 'incoming', fromMe: false
  }, policy, ownerIds)
  assert.deepEqual(ownerDirect, {
    mode: 'rules_only', policyValid: true, actorLevel: 'L1', roomLevel: 'L1', effectiveLevel: 'L1',
    audience: 'private', actorIsOwner: true, privateDataAllowed: true, managePermissionsAllowed: true
  })

  const configuredDirect = permissionForMessage({
    chatId: otherId, senderId: otherId, direction: 'incoming', fromMe: false
  }, policy, ownerIds)
  assert.equal(configuredDirect.actorLevel, 'L2')
  assert.equal(configuredDirect.effectiveLevel, 'L2')
  assert.equal(configuredDirect.privateDataAllowed, false)
  assert.equal(configuredDirect.managePermissionsAllowed, false)

  const wrongPrivateChat = permissionForMessage({
    chatId: otherId, senderId: ownerId, direction: 'incoming', fromMe: false
  }, policy, ownerIds)
  assert.equal(wrongPrivateChat.actorIsOwner, false)
  assert.equal(wrongPrivateChat.actorLevel, 'L5')
  assert.equal(wrongPrivateChat.effectiveLevel, 'L5')
  assert.equal(wrongPrivateChat.privateDataAllowed, false)
  assert.equal(wrongPrivateChat.managePermissionsAllowed, false)

  const ownerGroup = permissionForMessage({
    chatId: groupId, senderId: ownerId, direction: 'incoming', fromMe: false
  }, policy, ownerIds)
  assert.equal(ownerGroup.actorIsOwner, true)
  assert.equal(ownerGroup.actorLevel, 'L1')
  assert.equal(ownerGroup.roomLevel, 'L4')
  assert.equal(ownerGroup.effectiveLevel, 'L4')
  assert.equal(ownerGroup.privateDataAllowed, false)
  assert.equal(ownerGroup.managePermissionsAllowed, false)

  const outgoing = permissionForMessage({
    chatId: ownerId, senderId: ownerId, direction: 'outgoing', fromMe: true
  }, policy, ownerIds)
  assert.equal(outgoing.actorIsOwner, false)
  assert.equal(outgoing.actorLevel, 'L5')

  const invalid = permissionForMessage({
    chatId: ownerId, senderId: ownerId, direction: 'incoming', fromMe: false
  }, { ...policy, valid: false }, ownerIds)
  assert.equal(invalid.actorIsOwner, true)
  assert.equal(invalid.actorLevel, 'L1')
  assert.equal(invalid.effectiveLevel, 'L5')
  assert.equal(invalid.privateDataAllowed, false)
  assert.equal(invalid.managePermissionsAllowed, false)
})
