import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MetaBridge } from './meta-bridge.mjs'

function json(data, status = 200) {
  const body = JSON.stringify(data)
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
}

function fakeMeta({ failSend = false, sendErrorCode = null } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    const body = options.body ? String(options.body) : ''
    calls.push({ url: parsed.toString(), options: { ...options, signal: undefined }, body })
    if (parsed.hostname === 'api.instagram.com' && parsed.pathname === '/oauth/access_token') {
      return json({ access_token: 'ig-short-secret', user_id: 101 })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/access_token') {
      return json({ access_token: 'ig-long-secret', expires_in: 5_184_000 })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/me') {
      return json({ id: '101', user_id: '101', username: 'shop.example' })
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/v26.0/101/subscribed_apps') {
      return json({ success: true })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/oauth/access_token') {
      return body.includes('grant_type=fb_exchange_token')
        ? json({ access_token: 'facebook-long-secret', expires_in: 5_184_000 })
        : json({ access_token: 'facebook-user-secret' })
    }
    if (parsed.hostname === 'graph.facebook.com' && parsed.pathname === '/v26.0/me/accounts') {
      return json({ data: [
        { id: '201', name: 'First Page', access_token: 'page-one-secret' },
        { id: '202', name: 'Second Page', access_token: 'page-two-secret' }
      ] })
    }
    if (parsed.hostname === 'graph.facebook.com' && /^\/v26\.0\/(201|202)$/.test(parsed.pathname) && options.method === 'GET') {
      const id = parsed.pathname.split('/').at(-1)
      return json({ id, name: id === '201' ? 'First Page' : 'Second Page' })
    }
    if (parsed.hostname === 'graph.facebook.com' && /^\/v26\.0\/(201|202)\/subscribed_apps$/.test(parsed.pathname)) {
      return json({ success: true })
    }
    if (/\/v26\.0\/(101|202)\/messages$/.test(parsed.pathname)) {
      if (sendErrorCode !== null) {
        return json({ error: { type: 'OAuthException', code: sendErrorCode, message: 'provider secret must stay private' } }, sendErrorCode === 190 ? 400 : 403)
      }
      if (failSend) throw new Error('network includes secret ig-long-secret')
      return json({ recipient_id: '301', message_id: `sent-${calls.length}` })
    }
    throw new Error(`Unexpected fake Meta request: ${options.method} ${parsed}`)
  }
  return { calls, fetchImpl }
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'meta-bridge-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const clock = { value: options.now ?? 1_800_000_000_000 }
  const transport = fakeMeta(options)
  const bridge = new MetaBridge({
    dataDir,
    publicUrl: 'https://bridge.example',
    now: () => clock.value,
    fetchImpl: transport.fetchImpl,
    ownerIds: options.ownerIds ?? (() => new Set(['owner-1']))
  })
  await bridge.start()
  return { bridge, clock, dataDir, ...transport }
}

async function saveConfig(bridge, platform, values = {}) {
  return bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-config',
    platform,
    appId: platform === 'instagram' ? '10001' : '20001',
    appSecret: `${platform}-app-secret`,
    verifyToken: `${platform}-verify-token`,
    ...values
  })
}

async function connectInstagram(bridge, sessionHash = 'admin-session') {
  await saveConfig(bridge, 'instagram')
  const { authorizationUrl } = await bridge.beginAuthorization('instagram', sessionHash)
  const state = new URL(authorizationUrl).searchParams.get('state')
  return bridge.completeAuthorization('instagram', { code: 'instagram-code', state, sessionHash })
}

async function connectFacebook(bridge, sessionHash = 'admin-session') {
  await saveConfig(bridge, 'facebook')
  const { authorizationUrl } = await bridge.beginAuthorization('facebook', sessionHash)
  const state = new URL(authorizationUrl).searchParams.get('state')
  await bridge.completeAuthorization('facebook', { code: 'facebook-code', state, sessionHash })
  return bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'select-account',
    platform: 'facebook',
    accountId: '202'
  })
}

function webhookBody({
  object = 'instagram',
  accountId = '101',
  senderId = '301',
  id = 'incoming-1',
  timestamp = 1_800_000_000_001,
  text = 'Hello',
  message = {}
} = {}) {
  return Buffer.from(JSON.stringify({
    object,
    entry: [{
      id: accountId,
      messaging: [{
        sender: { id: senderId, username: 'forged-owner-name' },
        recipient: { id: accountId },
        timestamp,
        message: { mid: id, text, ...message }
      }]
    }]
  }))
}

function signature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function ingestInstagram(bridge, values = {}) {
  const body = webhookBody(values)
  return bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body))
}

test('starts unconfigured, persists bounded private state, redacts secrets, and enforces revisions', async (t) => {
  const { bridge, dataDir } = await fixture(t)
  const initial = bridge.getConsoleState()
  assert.equal(initial.channels.instagram.status, 'not_configured')
  assert.equal(initial.channels.instagram.autoReplyEnabled, false)
  assert.deepEqual(initial.channels.instagram.capabilities, {
    direct: true, groups: false, text: true, image: true, quote: false
  })
  assert.equal(initial.metaConfig.instagram.callbackUrl, 'https://bridge.example/admin/meta/callback/instagram')
  assert.equal(initial.metaConfig.instagram.webhookUrl, 'https://bridge.example/webhooks/meta/instagram')

  const saved = await saveConfig(bridge, 'instagram')
  assert.equal(saved.channels.instagram.status, 'ready_to_authorize')
  assert.equal(saved.metaConfig.instagram.hasAppSecret, true)
  assert.equal(JSON.stringify(saved).includes('instagram-app-secret'), false)
  await assert.rejects(saveConfig(bridge, 'instagram', { revision: 0 }), (error) => error.status === 409)

  const statePath = join(dataDir, 'meta-state.json')
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dataDir), ['meta-state.json'])
  const persisted = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(persisted.platforms.instagram.config.appSecret, 'instagram-app-secret')
})

test('fails Meta closed for unsafe, symlinked, or unknown-schema state without throwing from start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meta-bridge-unsafe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, prepare] of [
    ['mode', async (dir) => {
      await writeFile(join(dir, 'meta-state.json'), JSON.stringify({ version: 1 }), { mode: 0o600 })
      await chmod(join(dir, 'meta-state.json'), 0o644)
    }],
    ['schema', async (dir) => writeFile(join(dir, 'meta-state.json'), JSON.stringify({ version: 1, surprise: true }), { mode: 0o600 })],
    ['symlink', async (dir) => {
      const target = join(dir, 'target.json')
      await writeFile(target, JSON.stringify({ version: 1 }), { mode: 0o600 })
      await symlink(target, join(dir, 'meta-state.json'))
    }]
  ]) {
    const dataDir = join(root, name)
    await (await import('node:fs/promises')).mkdir(dataDir)
    await prepare(dataDir)
    const bridge = new MetaBridge({ dataDir, publicUrl: 'https://bridge.example', fetchImpl: async () => json({}) })
    const state = await bridge.start()
    assert.equal(state.channels.instagram.status, 'error')
    assert.equal(state.channels.facebook.status, 'error')
    await assert.rejects(bridge.beginAuthorization('instagram', 'session'), (error) => error.status === 503)
  }
})

test('binds OAuth to one admin session, consumes state once, and keeps credentials out of URLs and results', async (t) => {
  const { bridge, calls, clock } = await fixture(t)
  await saveConfig(bridge, 'instagram')
  const first = await bridge.beginAuthorization('instagram', 'session-a')
  const firstUrl = new URL(first.authorizationUrl)
  assert.equal(firstUrl.origin, 'https://www.instagram.com')
  assert.equal(firstUrl.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages')
  const firstState = firstUrl.searchParams.get('state')
  await assert.rejects(
    bridge.completeAuthorization('instagram', { code: 'code', state: firstState, sessionHash: 'session-b' }),
    (error) => error.status === 403
  )
  await assert.rejects(
    bridge.completeAuthorization('instagram', { code: 'code', state: firstState, sessionHash: 'session-a' }),
    (error) => error.status === 403
  )

  const second = await bridge.beginAuthorization('instagram', 'session-a')
  const secondState = new URL(second.authorizationUrl).searchParams.get('state')
  const connected = await bridge.completeAuthorization('instagram', { code: 'code', state: secondState, sessionHash: 'session-a' })
  assert.equal(connected.channels.instagram.status, 'connected')
  assert.equal(connected.channels.instagram.tokenExpiresAt, clock.value + 5_184_000 * 1000)
  assert.deepEqual(connected.assets, [{ id: '101', name: 'shop.example', username: 'shop.example' }])
  assert.equal(JSON.stringify(connected).includes('ig-long-secret'), false)
  const exchange = calls.find((call) => new URL(call.url).pathname === '/access_token'
    && new URL(call.url).hostname === 'graph.instagram.com')
  assert.equal(exchange.options.method, 'GET')
  assert.equal(new URL(exchange.url).searchParams.get('grant_type'), 'ig_exchange_token')
  assert.equal(new URL(exchange.url).searchParams.get('client_secret'), 'instagram-app-secret')
  assert.equal(new URL(exchange.url).searchParams.get('access_token'), 'ig-short-secret')
  assert.equal(JSON.stringify(connected).includes('ig-short-secret'), false)
  assert.equal(calls.find((call) => call.url.includes('/me?')).options.headers.authorization, 'Bearer ig-long-secret')
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-config', platform: 'instagram', appId: '10001', appSecret: '', verifyToken: ''
  })
  assert.equal(bridge.getStatus('instagram').status, 'connected')
  assert.equal(bridge.verifyWebhook('instagram', new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.verify_token': 'instagram-verify-token', 'hub.challenge': 'kept'
  })), 'kept')
  await assert.rejects(
    bridge.completeAuthorization('instagram', { code: 'code', state: secondState, sessionHash: 'session-a' }),
    (error) => error.status === 403
  )
  clock.value += 5_184_000 * 1000
  assert.equal(bridge.getStatus('instagram').status, 'expired')
})

test('lists Facebook Pages privately and verifies the exact selected Page before connecting', async (t) => {
  const { bridge, calls, dataDir, clock } = await fixture(t)
  await saveConfig(bridge, 'facebook')
  const { authorizationUrl } = await bridge.beginAuthorization('facebook', 'admin')
  const auth = new URL(authorizationUrl)
  assert.equal(auth.origin, 'https://www.facebook.com')
  assert.equal(auth.pathname, '/v26.0/dialog/oauth')
  assert.equal(auth.searchParams.get('scope'), 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement')
  await bridge.completeAuthorization('facebook', {
    code: 'code', state: auth.searchParams.get('state'), sessionHash: 'admin'
  })
  assert.equal(bridge.getStatus('facebook').status, 'select_account')
  assert.deepEqual(bridge.getStatus('facebook').assets, [
    { id: '201', name: 'First Page' }, { id: '202', name: 'Second Page' }
  ])
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'select-account', platform: 'facebook', accountId: '999'
  }), (error) => error.status === 404)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'select-account', platform: 'facebook', accountId: '202'
  })
  assert.deepEqual(bridge.getStatus('facebook').account, { id: '202', name: 'Second Page' })
  assert.equal(bridge.getStatus('facebook').tokenExpiresAt, clock.value + 5_184_000 * 1000)
  const verify = calls.find((call) => new URL(call.url).pathname === '/v26.0/202')
  assert.equal(verify.options.headers.authorization, 'Bearer page-two-secret')
  const pages = calls.find((call) => new URL(call.url).pathname === '/v26.0/me/accounts')
  assert.equal(pages.options.headers.authorization, 'Bearer facebook-long-secret')
  const persisted = JSON.parse(await readFile(join(dataDir, 'meta-state.json'), 'utf8'))
  assert.equal(persisted.platforms.facebook.assets.find((asset) => asset.id === '201').accessToken, null)
  assert.equal(JSON.stringify(persisted).includes('page-one-secret'), false)
  assert.equal(JSON.stringify(bridge.getConsoleState()).includes('page-one-secret'), false)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'select-account', platform: 'facebook', accountId: '201'
  }), (error) => error.status === 409)
})

test('never exposes messages, media, users, or chats from a previously selected account', async (t) => {
  const { bridge, clock } = await fixture(t)
  await connectFacebook(bridge)
  clock.value += 1
  const body = webhookBody({
    object: 'page', accountId: '202', senderId: '302', id: 'page-202-media', timestamp: clock.value,
    text: null, message: { attachments: [{ type: 'image', payload: {
      url: 'https://cdn.example/page-202-private.jpg', attachment_id: 'page-202-file'
    } }] }
  })
  await bridge.ingestWebhook('facebook', body, signature('facebook-app-secret', body))
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-user', platform: 'facebook', senderId: '302', displayName: 'Old account user', level: 'L3'
  })
  assert.equal(bridge.listChats({ platform: 'facebook' }).length, 1)
  assert.equal(bridge.getConsoleState().metaUsers.length, 1)

  const { authorizationUrl } = await bridge.beginAuthorization('facebook', 'reauthorize')
  await bridge.completeAuthorization('facebook', {
    code: 'new-code', state: new URL(authorizationUrl).searchParams.get('state'), sessionHash: 'reauthorize'
  })
  assert.deepEqual(bridge.getMessages({ platform: 'facebook', chatId: 'facebook:202:302' }), [])
  assert.equal(bridge.getMediaDescriptor({
    platform: 'facebook', chatId: 'facebook:202:302', messageId: 'page-202-media'
  }), null)
  assert.deepEqual(bridge.getConsoleState().metaUsers, [])
  assert.deepEqual(bridge.getConsoleState().metaConversations, [])

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'select-account', platform: 'facebook', accountId: '201'
  })
  assert.deepEqual(bridge.listChats({ platform: 'facebook' }), [])
  assert.deepEqual(bridge.getPendingReplies({ platform: 'facebook', after: 0 }), [])
  assert.equal(bridge.getMediaDescriptor({
    platform: 'facebook', chatId: 'facebook:202:302', messageId: 'page-202-media'
  }), null)

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'disconnect', platform: 'facebook'
  })
  assert.deepEqual(bridge.getMessages({ platform: 'facebook', chatId: 'facebook:202:302' }), [])
})

test('verifies exact raw webhook bytes, scopes accounts, deduplicates, and keeps media URLs private', async (t) => {
  const { bridge, clock } = await fixture(t)
  await connectInstagram(bridge)
  assert.equal(bridge.verifyWebhook('instagram', new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.verify_token': 'instagram-verify-token', 'hub.challenge': 'challenge-1'
  })), 'challenge-1')
  assert.throws(() => bridge.verifyWebhook('instagram', new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'challenge-1'
  })), (error) => error.status === 403)

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  const emitted = []
  bridge.on('message', (message) => emitted.push(message))
  const body = webhookBody({
    timestamp: clock.value,
    text: null,
    message: { attachments: [{ type: 'image', payload: {
      url: 'https://cdn.example/private-token.jpg', attachment_id: 'file-1', mime_type: 'image/jpeg', name: 'photo.jpg'
    } }] }
  })
  await assert.rejects(bridge.ingestWebhook('instagram', body, signature('wrong-secret', body)), (error) => error.status === 403)
  assert.deepEqual(await bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)), { stored: 1, emitted: 1 })
  assert.deepEqual(await bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)), { stored: 0, emitted: 0 })
  assert.equal(emitted.length, 1)
  assert.equal(JSON.stringify(emitted[0]).includes('private-token'), false)
  assert.deepEqual(emitted[0].media, { mimetype: 'image/jpeg', fileName: 'photo.jpg' })
  assert.deepEqual(bridge.getMediaDescriptor({
    platform: 'instagram', chatId: 'instagram:101:301', messageId: 'incoming-1'
  }), {
    download_url: 'https://cdn.example/private-token.jpg', file_id: 'file-1', mime_type: 'image/jpeg',
    file_name: 'photo.jpg', mediaType: 'image'
  })

  const foreign = webhookBody({ accountId: '999', senderId: '301', id: 'foreign', timestamp: clock.value + 1 })
  assert.deepEqual(await bridge.ingestWebhook('instagram', foreign, signature('instagram-app-secret', foreign)), { stored: 0, emitted: 0 })
  const echo = webhookBody({ id: 'echo', timestamp: clock.value + 1, message: { is_echo: true } })
  assert.deepEqual(await bridge.ingestWebhook('instagram', echo, signature('instagram-app-secret', echo)), { stored: 0, emitted: 0 })
})

test('pause and resume set a fresh cutoff, store paused messages, and never backfill them', async (t) => {
  const { bridge, clock } = await fixture(t)
  await connectInstagram(bridge)
  const emitted = []
  bridge.on('message', (message) => emitted.push(message.id))

  clock.value += 1
  await ingestInstagram(bridge, { id: 'paused-1', timestamp: clock.value })
  assert.deepEqual(emitted, [])
  assert.equal(bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' }).length, 1)

  clock.value += 1
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  assert.deepEqual(bridge.getPendingReplies({ platform: 'instagram', after: 0 }), [])
  await ingestInstagram(bridge, { id: 'cutoff-equal', timestamp: clock.value })
  assert.deepEqual(emitted, [])
  clock.value += 1
  await ingestInstagram(bridge, { id: 'fresh', timestamp: clock.value })
  assert.deepEqual(emitted, ['fresh'])

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: false
  })
  clock.value += 1
  await ingestInstagram(bridge, { id: 'paused-2', timestamp: clock.value })
  clock.value += 1
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  assert.equal(bridge.getPendingReplies({ platform: 'instagram', after: 0 }).some((message) => message.id === 'paused-2'), false)

  await bridge.stop()
  clock.value += 100
  await bridge.start()
  await ingestInstagram(bridge, { id: 'during-restart', timestamp: clock.value - 1 })
  assert.equal(emitted.includes('during-restart'), false)
})

test('commits console settings only after durable persistence succeeds', async (t) => {
  const unconfigured = await fixture(t)
  await chmod(unconfigured.dataDir, 0o500)
  try {
    await assert.rejects(saveConfig(unconfigured.bridge, 'instagram'))
  } finally {
    await chmod(unconfigured.dataDir, 0o700)
  }
  assert.equal(unconfigured.bridge.getStatus('instagram').status, 'not_configured')
  assert.equal(unconfigured.bridge.getConsoleState().metaRevision, 0)

  const connected = await fixture(t)
  await connectInstagram(connected.bridge)
  connected.clock.value += 1
  await ingestInstagram(connected.bridge, { id: 'rollback-user', timestamp: connected.clock.value })
  const revision = connected.bridge.getConsoleState().metaRevision
  await chmod(connected.dataDir, 0o500)
  try {
    await assert.rejects(connected.bridge.updateConsoleSettings({
      revision, action: 'set-replies', platform: 'instagram', enabled: true
    }))
    await assert.rejects(connected.bridge.updateConsoleSettings({
      revision, action: 'bind-owner', platform: 'instagram', senderId: '301', ownerId: 'owner-1'
    }))
  } finally {
    await chmod(connected.dataDir, 0o700)
  }
  assert.equal(connected.bridge.getStatus('instagram').autoReplyEnabled, false)
  assert.equal(connected.bridge.getConsoleState().metaRevision, revision)
  const message = connected.bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' })[0]
  assert.equal(message.permission.actorIsOwner, false)

  const pages = await fixture(t)
  await saveConfig(pages.bridge, 'facebook')
  const { authorizationUrl } = await pages.bridge.beginAuthorization('facebook', 'admin')
  await pages.bridge.completeAuthorization('facebook', {
    code: 'code', state: new URL(authorizationUrl).searchParams.get('state'), sessionHash: 'admin'
  })
  const pageRevision = pages.bridge.getConsoleState().metaRevision
  await chmod(pages.dataDir, 0o500)
  try {
    await assert.rejects(pages.bridge.updateConsoleSettings({
      revision: pageRevision, action: 'select-account', platform: 'facebook', accountId: '202'
    }))
  } finally {
    await chmod(pages.dataDir, 0o700)
  }
  assert.equal(pages.bridge.getStatus('facebook').status, 'select_account')
  assert.equal(pages.bridge.getStatus('facebook').account, null)
  assert.equal(pages.bridge.getConsoleState().metaRevision, pageRevision)
})

test('does not poison webhook dedupe when persistence fails', async (t) => {
  const { bridge, clock, dataDir } = await fixture(t)
  await connectInstagram(bridge)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  const body = webhookBody({ id: 'retry-after-disk-failure', timestamp: clock.value })
  const emitted = []
  bridge.on('message', (message) => emitted.push(message.id))
  await chmod(dataDir, 0o500)
  try {
    await assert.rejects(bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)))
  } finally {
    await chmod(dataDir, 0o700)
  }
  assert.deepEqual(emitted, [])
  assert.deepEqual(await bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)), {
    stored: 1, emitted: 1
  })
  assert.deepEqual(emitted, ['retry-after-disk-failure'])
})

test('acknowledges webhook dedupe only after downstream durable handoff', async (t) => {
  const { bridge, clock } = await fixture(t)
  await connectInstagram(bridge)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  const body = webhookBody({ id: 'durable-handoff', timestamp: clock.value })
  let attempts = 0
  bridge.setMessagePublisher(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('event queue persistence failed')
  })
  await assert.rejects(bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)))
  assert.equal(bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' }).length, 1)
  assert.deepEqual(await bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)), {
    stored: 0, emitted: 1
  })
  assert.equal(attempts, 2)
  assert.deepEqual(await bridge.ingestWebhook('instagram', body, signature('instagram-app-secret', body)), {
    stored: 0, emitted: 0
  })
  assert.equal(attempts, 2)

  clock.value += 1
  const paused = webhookBody({ id: 'durable-paused', timestamp: clock.value })
  bridge.setMessagePublisher(async () => { throw new Error('should not run while paused') })
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: false
  })
  assert.deepEqual(await bridge.ingestWebhook('instagram', paused, signature('instagram-app-secret', paused)), {
    stored: 1, emitted: 0
  })
})

test('owner binding uses exact observed provider identity and recomputes active owner permissions', async (t) => {
  const activeOwners = new Set(['owner-1'])
  const { bridge, clock } = await fixture(t, { ownerIds: () => activeOwners })
  await connectInstagram(bridge)
  clock.value += 1
  await ingestInstagram(bridge, { id: 'identity', timestamp: clock.value, senderId: '301' })

  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-user', platform: 'instagram', senderId: '301', displayName: 'Alice', level: 'L1'
  }))
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'bind-owner', platform: 'instagram', senderId: '301', ownerId: 'forged-owner-name'
  }), (error) => error.status === 403)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'bind-owner', platform: 'instagram', senderId: '999', ownerId: 'owner-1'
  }), (error) => error.status === 404)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-user', platform: 'instagram', accountId: '999', senderId: '301', displayName: 'Alice', level: 'L3'
  }), (error) => error.status === 409)

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'save-user', platform: 'instagram', senderId: '301', displayName: 'Alice', level: 'L3'
  })
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'bind-owner', platform: 'instagram', senderId: '301', ownerId: 'owner-1'
  })
  let message = bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' })[0]
  assert.equal(message.permission.actorLevel, 'L1')
  assert.equal(message.permission.privateDataAllowed, true)

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  await ingestInstagram(bridge, { id: 'owner-live', timestamp: clock.value, senderId: '301' })
  message = bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' })
    .find((item) => item.id === 'owner-live')
  assert.equal(bridge.canDeliver({ ...message, timestamp: new Date(message.timestamp).toISOString() }), true)
  activeOwners.delete('owner-1')
  assert.equal(bridge.canDeliver({ ...message, timestamp: new Date(message.timestamp).toISOString() }), false)
  message = bridge.getMessages({ platform: 'instagram', chatId: 'instagram:101:301' })
    .find((item) => item.id === 'identity')
  assert.equal(message.permission.actorLevel, 'L3')
  assert.equal(message.permission.privateDataAllowed, false)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'delete-user', platform: 'instagram', senderId: '301'
  }), (error) => error.status === 409)
})

test('sends only fresh same-chat replies and makes sent receipts idempotent even while paused', async (t) => {
  const { bridge, clock, calls } = await fixture(t)
  await connectInstagram(bridge)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  await ingestInstagram(bridge, { id: 'source-1', timestamp: clock.value })
  assert.equal(bridge.getPendingReplies({ platform: 'instagram', after: 0 })[0].id, 'source-1')
  const result = await bridge.sendText({
    platform: 'instagram', chatId: 'instagram:101:301', text: 'Reply',
    idempotencyKey: 'reply-1', sourceMessageId: 'source-1'
  })
  const sendCalls = () => calls.filter((call) => new URL(call.url).pathname.endsWith('/messages'))
  assert.equal(sendCalls().length, 1)
  const sentBody = JSON.parse(sendCalls()[0].body)
  assert.equal(sentBody.message.text, 'Reply')
  assert.equal('reply_to' in sentBody.message, false)
  assert.equal('messaging_type' in sentBody, false)
  assert.equal(JSON.stringify(sentBody).includes('HUMAN_AGENT'), false)
  assert.deepEqual(bridge.getPendingReplies({ platform: 'instagram', after: 0 }), [])

  await bridge.sendImage({
    platform: 'instagram', chatId: 'instagram:101:301',
    imageUrl: 'https://bridge.example/media/abcdefghijklmnop',
    idempotencyKey: 'image-1', sourceMessageId: 'source-1'
  })
  assert.deepEqual(JSON.parse(sendCalls()[1].body).message.attachment, {
    type: 'image', payload: { url: 'https://bridge.example/media/abcdefghijklmnop', is_reusable: true }
  })

  const digest = 'a'.repeat(64)
  const digestResult = await bridge.sendImage({
    platform: 'instagram', chatId: 'instagram:101:301',
    imageUrl: 'https://bridge.example/media/firstcapability123', imageDigest: digest,
    idempotencyKey: 'digest-image', sourceMessageId: 'source-1'
  })
  assert.equal(sendCalls().length, 3)
  assert.deepEqual(await bridge.sendImage({
    platform: 'instagram', chatId: 'instagram:101:301',
    imageUrl: 'https://bridge.example/media/secondcapability12', imageDigest: digest.toUpperCase(),
    idempotencyKey: 'digest-image', sourceMessageId: 'source-1'
  }), digestResult)
  assert.equal(sendCalls().length, 3)
  await assert.rejects(bridge.sendImage({
    platform: 'instagram', chatId: 'instagram:101:301',
    imageUrl: 'https://bridge.example/media/thirdcapability123', imageDigest: 'b'.repeat(64),
    idempotencyKey: 'digest-image', sourceMessageId: 'source-1'
  }), (error) => error.status === 409)

  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: false
  })
  assert.deepEqual(await bridge.sendText({
    platform: 'instagram', chatId: 'instagram:101:301', text: 'Reply',
    idempotencyKey: 'reply-1', sourceMessageId: 'source-1'
  }), result)
  assert.equal(sendCalls().length, 3)
  await assert.rejects(bridge.sendText({
    platform: 'instagram', chatId: 'instagram:101:301', text: 'Changed',
    idempotencyKey: 'reply-1', sourceMessageId: 'source-1'
  }), (error) => error.status === 409)
  await assert.rejects(bridge.sendImage({
    platform: 'instagram', chatId: 'instagram:101:301', imageUrl: 'https://attacker.example/media/abcdefghijklmnop',
    idempotencyKey: 'image-1', sourceMessageId: 'source-1'
  }))
})

test('rejects expired windows and retains unknown send outcomes without blind retry or leaking errors', async (t) => {
  const { bridge, clock, calls } = await fixture(t, { failSend: true })
  await connectInstagram(bridge)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'instagram', enabled: true
  })
  clock.value += 1
  await ingestInstagram(bridge, { id: 'source-unknown', timestamp: clock.value })
  let firstError
  try {
    await bridge.sendText({
      platform: 'instagram', chatId: 'instagram:101:301', text: 'Reply',
      idempotencyKey: 'unknown-1', sourceMessageId: 'source-unknown'
    })
  } catch (error) { firstError = error }
  assert.equal(firstError.status, 502)
  assert.equal(firstError.message.includes('secret'), false)
  const count = calls.filter((call) => new URL(call.url).pathname.endsWith('/messages')).length
  await assert.rejects(bridge.sendText({
    platform: 'instagram', chatId: 'instagram:101:301', text: 'Reply',
    idempotencyKey: 'unknown-1', sourceMessageId: 'source-unknown'
  }), (error) => error.code === 'EUNKNOWN')
  assert.equal(calls.filter((call) => new URL(call.url).pathname.endsWith('/messages')).length, count)

  clock.value += 24 * 60 * 60 * 1000
  await assert.rejects(bridge.sendText({
    platform: 'instagram', chatId: 'instagram:101:301', text: 'Late',
    idempotencyKey: 'late-1', sourceMessageId: 'source-unknown'
  }), (error) => error.status === 409)
})

test('treats provider code 190 as expired without misclassifying ordinary 403 responses', async (t) => {
  for (const [providerCode, expected] of [[190, 'expired'], [10, 'connected']]) {
    const current = await fixture(t, { sendErrorCode: providerCode })
    await connectInstagram(current.bridge)
    await current.bridge.updateConsoleSettings({
      revision: current.bridge.getConsoleState().metaRevision,
      action: 'set-replies', platform: 'instagram', enabled: true
    })
    current.clock.value += 1
    await ingestInstagram(current.bridge, { id: `provider-error-${providerCode}`, timestamp: current.clock.value })
    let sendError
    try {
      await current.bridge.sendText({
        platform: 'instagram', chatId: 'instagram:101:301', text: 'Reply',
        idempotencyKey: `provider-error-${providerCode}`, sourceMessageId: `provider-error-${providerCode}`
      })
    } catch (error) { sendError = error }
    assert.equal(sendError.message.includes('provider secret'), false)
    assert.equal(current.bridge.getStatus('instagram').status, expected)
    assert.equal(current.bridge.getStatus('instagram').autoReplyEnabled, providerCode === 10)
    assert.equal(current.bridge.getStatus('instagram').lastError,
      providerCode === 190 ? 'Meta authorization expired' : 'Meta send failed')
  }
})

test('Facebook uses RESPONSE without claiming unsupported quoted replies', async (t) => {
  const { bridge, clock, calls } = await fixture(t)
  await connectFacebook(bridge)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().metaRevision,
    action: 'set-replies', platform: 'facebook', enabled: true
  })
  clock.value += 1
  const body = webhookBody({ object: 'page', accountId: '202', senderId: '302', id: 'fb-source', timestamp: clock.value })
  await bridge.ingestWebhook('facebook', body, signature('facebook-app-secret', body))
  await bridge.sendText({
    platform: 'facebook', chatId: 'facebook:202:302', text: 'Page reply',
    idempotencyKey: 'fb-reply', sourceMessageId: 'fb-source'
  })
  const sent = calls.find((call) => new URL(call.url).pathname === '/v26.0/202/messages')
  assert.equal(JSON.parse(sent.body).messaging_type, 'RESPONSE')
  assert.equal('reply_to' in JSON.parse(sent.body).message, false)
  assert.equal(bridge.getStatus('facebook').capabilities.quote, false)
  assert.equal(bridge.getStatus('instagram').capabilities.quote, false)
})
