import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { InstagramPrivateBridge } from './instagram-private.mjs'

const ACCOUNT_ID = '1001'
const OWNER_SENDER = '2001'
const OTHER_SENDER = '2002'

class FakeWorker {
  constructor() {
    this.account = { id: ACCOUNT_ID, username: 'dot_test' }
    this.status = 'connected'
    this.threads = new Map()
    this.pollThreads = []
    this.calls = []
    this.nextSent = 1
    this.threadBarrier = null
  }

  async request(operation, params) {
    this.calls.push({ operation, params: structuredClone(params) })
    if (operation === 'status') return { status: this.status, account: this.account }
    if (operation === 'poll') return { account: this.account, threads: structuredClone(this.pollThreads) }
    if (operation === 'thread') {
      if (this.threadBarrier) {
        const barrier = this.threadBarrier
        this.threadBarrier = null
        barrier.entered()
        await barrier.wait
      }
      const thread = this.threads.get(params.threadId)
      if (!thread) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
      return { ...structuredClone(thread), messages: structuredClone(thread.messages).slice(-params.limit) }
    }
    if (operation === 'send_text' || operation === 'send_image') {
      return { messageId: String(9000 + this.nextSent++), timestamp: 1_900_000_000_010 }
    }
    throw new Error('unexpected operation')
  }

  async stop() {}

  setThread(thread) {
    this.threads.set(thread.id, structuredClone(thread))
    this.pollThreads = [structuredClone(thread)]
  }

  blockNextThread() {
    let entered
    let release
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const wait = new Promise((resolve) => { release = resolve })
    this.threadBarrier = { entered, wait }
    return { entered: enteredPromise, release }
  }
}

function message({ id = '3001', senderId = OWNER_SENDER, timestamp = 1_900_000_000_001, text = 'hello', media = undefined } = {}) {
  return {
    id,
    senderId,
    text: media ? null : text,
    timestamp,
    fromMe: false,
    mediaType: media ? 'image' : null,
    ...(media ? { media } : {})
  }
}

function thread({ id = '4001', isGroup = false, memberIds = [ACCOUNT_ID, OWNER_SENDER], messages = [message()], title = null } = {}) {
  return { id, isGroup, title, memberIds, messages }
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'instagram-private-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const worker = options.worker ?? new FakeWorker()
  const clock = { value: 1_900_000_000_000 }
  const owners = options.owners ?? new Set(['owner-1'])
  const bridge = new InstagramPrivateBridge({
    dataDir,
    worker,
    now: () => clock.value,
    ownerIds: () => owners,
    pollIntervalMs: 10
  })
  await bridge.start()
  return { bridge, clock, dataDir, owners, worker }
}

async function configure(bridge) {
  return bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'configure',
    expectedAccountId: ACCOUNT_ID
  })
}

async function setReplies(bridge, enabled = true) {
  return bridge.updateConsoleSettings({ revision: bridge.getConsoleState().revision, action: 'set-replies', enabled })
}

test('keeps independent private state, immutable account scope, strict modes, and no messages in console state', async (t) => {
  const { bridge, dataDir, worker } = await fixture(t)
  assert.equal(bridge.getStatus().status, 'not_configured')
  assert.equal(worker.calls.length, 0)
  const connected = await configure(bridge)
  assert.equal(connected.channel.status, 'paused')
  assert.deepEqual(connected.channel.capabilities, { direct: true, groups: true, text: true, image: true })
  assert.equal('messages' in connected, false)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: connected.revision,
    action: 'configure',
    expectedAccountId: '9999'
  }), (error) => error.code === 'EIMMUTABLE')
  await assert.rejects(bridge.updateConsoleSettings({
    revision: connected.revision,
    action: 'save-user',
    senderId: OWNER_SENDER,
    displayName: 'Owner',
    level: 'L1'
  }))
  const path = join(dataDir, 'instagram-private-state.json')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await readFile(path, 'utf8')).includes('password'), false)
})

test('fails only this adapter closed on unsafe or corrupt state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'instagram-private-bad-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, prepare] of [
    ['mode', async (path) => {
      await writeFile(path, '{}', { mode: 0o600 })
      await chmod(path, 0o644)
    }],
    ['schema', async (path) => writeFile(path, '{"version":1,"extra":true}', { mode: 0o600 })],
    ['symlink', async (path, dir) => {
      const target = join(dir, 'target.json')
      await writeFile(target, '{}', { mode: 0o600 })
      await symlink(target, path)
    }]
  ]) {
    const dataDir = join(root, name)
    await mkdir(dataDir)
    await prepare(join(dataDir, 'instagram-private-state.json'), dataDir)
    const bridge = new InstagramPrivateBridge({ dataDir, worker: new FakeWorker(), pollIntervalMs: 10 })
    const state = await bridge.start()
    assert.equal(state.channel.status, 'error')
    await assert.rejects(bridge.updateConsoleSettings({ revision: 0, action: 'configure', expectedAccountId: ACCOUNT_ID }),
      (error) => error.status === 503)
    await bridge.stop()
  }
})

test('persists before publishing, retries publisher failures, and applies L5 public-safe DM permissions', async (t) => {
  const { bridge, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  let attempts = 0
  const received = []
  bridge.setMessagePublisher(async (published) => {
    attempts += 1
    const disk = JSON.parse(await readFile(join(bridge.dataDir, 'instagram-private-state.json'), 'utf8'))
    assert.equal(disk.messages.some((item) => item.id === published.id), true)
    if (attempts === 1) throw new Error('queue unavailable')
    received.push(published)
  })
  await waitFor(() => received.length === 1)
  assert.equal(attempts, 2)
  assert.equal(received[0].permission.actorLevel, 'L5')
  assert.equal(received[0].permission.privateDataAllowed, false)
  assert.equal(received[0].chatId, `instagram_private:${ACCOUNT_ID}:dm:4001`)
  assert.deepEqual(bridge.getConsoleState().users, [{
    accountId: ACCOUNT_ID,
    senderId: OWNER_SENDER,
    displayName: OWNER_SENDER,
    level: 'L5',
    ownerId: null,
    actorIsOwner: false,
    observedOnly: true
  }])
  assert.equal((await bridge.getPendingReplies({ after: 0 })).length, 1)
})

test('binds owners only to observed senders and gates groups on a currently active owner member', async (t) => {
  const { bridge, worker, owners } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const dm = []
  bridge.setMessagePublisher(async (item) => dm.push(item))
  await waitFor(() => dm.length === 1)
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'save-user', senderId: OWNER_SENDER, displayName: 'Owner', level: 'L2'
  })
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'bind-owner', senderId: OWNER_SENDER, ownerId: 'owner-1'
  })
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'set-groups', enabled: true
  })
  const groupThread = thread({
    id: '5001',
    isGroup: true,
    title: 'Project group',
    memberIds: [ACCOUNT_ID, OWNER_SENDER, OTHER_SENDER],
    messages: [message({ id: '5002', senderId: OTHER_SENDER, timestamp: 1_900_000_000_002 })]
  })
  worker.setThread(groupThread)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)
  assert.deepEqual(published[0].permission, {
    mode: 'rules_only', actorLevel: 'L5', roomLevel: 'L5', effectiveLevel: 'L5', audience: 'group',
    actorIsOwner: false, policyValid: true, privateDataAllowed: false, managePermissionsAllowed: false
  })
  assert.deepEqual(await bridge.getGroupInfo({ chatId: published[0].chatId }), {
    id: published[0].chatId, title: 'Project group', botPresent: true, ownerPresent: true
  })
  assert.deepEqual(bridge.getConsoleState().groups, [{
    accountId: ACCOUNT_ID,
    threadId: '5001',
    chatId: published[0].chatId,
    name: 'Project group',
    displayName: 'Project group',
    level: 'L5',
    observedOnly: true
  }])
  assert.equal(bridge.getConsoleState().users.find((user) => user.senderId === OWNER_SENDER).observedOnly, false)
  assert.equal(bridge.getConsoleState().users.find((user) => user.senderId === OTHER_SENDER).observedOnly, true)
  const barrier = worker.blockNextThread()
  const messages = bridge.getMessages({ chatId: published[0].chatId })
  await barrier.entered
  owners.clear()
  barrier.release()
  assert.equal(await bridge.canDeliver(published[0]), false)
  assert.deepEqual(await messages, [])
})

test('uses one durable source-bound receipt for text or image and rechecks source membership', async (t) => {
  const { bridge, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)
  const sent = await bridge.sendText({
    chatId: published[0].chatId,
    sourceMessageId: published[0].id,
    text: 'reply',
    idempotencyKey: 'first-key'
  })
  assert.equal(sent.messageId, '9001')
  assert.deepEqual(await bridge.sendText({
    chatId: published[0].chatId,
    sourceMessageId: published[0].id,
    text: 'reply',
    idempotencyKey: 'different-key'
  }), sent)
  await assert.rejects(bridge.sendImage({
    chatId: published[0].chatId,
    sourceMessageId: published[0].id,
    data: Buffer.from('image'),
    mimetype: 'image/png',
    idempotencyKey: 'image-key'
  }), (error) => error.code === 'EIDEMPOTENCY')
  assert.equal(worker.calls.filter((call) => call.operation.startsWith('send_')).length, 1)
})

test('rejects a source whose trusted sender metadata or content changed', async (t) => {
  const { bridge, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)
  worker.setThread(thread({ messages: [message({ text: 'edited after observation' })] }))
  await assert.rejects(bridge.sendText({
    chatId: published[0].chatId,
    sourceMessageId: published[0].id,
    text: 'reply',
    idempotencyKey: 'immutable-source'
  }), /changed/)
  assert.equal(worker.calls.filter((call) => call.operation === 'send_text').length, 0)
})

test('keeps saved roles scoped to the immutable expected account while hiding mismatched sessions', async (t) => {
  const { bridge, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  await waitFor(() => bridge.getConsoleState().users.some((user) => user.senderId === OWNER_SENDER))
  await bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'save-user', senderId: OWNER_SENDER, displayName: 'Saved owner', level: 'L2'
  })
  worker.account = { id: '9999', username: 'wrong_account' }
  let state = await bridge.updateConsoleSettings({ revision: bridge.getConsoleState().revision, action: 'reconnect' })
  assert.equal(state.channel.status, 'error')
  assert.equal(state.settings.expectedAccountId, ACCOUNT_ID)
  assert.deepEqual(state.users, [])
  worker.account = { id: ACCOUNT_ID, username: 'dot_test' }
  state = await bridge.updateConsoleSettings({ revision: state.revision, action: 'reconnect' })
  assert.equal(state.users.find((user) => user.senderId === OWNER_SENDER).displayName, 'Saved owner')
  assert.equal(state.users.find((user) => user.senderId === OWNER_SENDER).observedOnly, false)
})

test('does not commit role updates when the copy-on-write state replacement fails', async (t) => {
  const { bridge, dataDir, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)
  const statePath = join(dataDir, 'instagram-private-state.json')
  await rm(statePath)
  await mkdir(statePath)
  await assert.rejects(bridge.updateConsoleSettings({
    revision: bridge.getConsoleState().revision,
    action: 'save-user', senderId: OWNER_SENDER, displayName: 'Owner', level: 'L2'
  }))
  assert.equal(bridge.getConsoleState().users[0].observedOnly, true)
  assert.equal(bridge.getConsoleState().users.some((user) => user.observedOnly === false), false)
})

test('fails before a physical send when the durable source receipt cannot be reserved', async (t) => {
  const { bridge, dataDir, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)
  const statePath = join(dataDir, 'instagram-private-state.json')
  await rm(statePath)
  await mkdir(statePath)
  await assert.rejects(bridge.sendText({
    chatId: published[0].chatId,
    sourceMessageId: published[0].id,
    text: 'must not send',
    idempotencyKey: 'disk-failure'
  }))
  assert.equal(worker.calls.filter((call) => call.operation === 'send_text').length, 0)
})

test('rechecks pause after asynchronous thread reads before pending delivery or physical sends', async (t) => {
  const { bridge, clock, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await setReplies(bridge)
  const published = []
  bridge.setMessagePublisher(async (item) => published.push(item))
  await waitFor(() => published.length === 1)

  let barrier = worker.blockNextThread()
  const pending = bridge.getPendingReplies({ after: 0 })
  await barrier.entered
  await setReplies(bridge, false)
  barrier.release()
  assert.deepEqual(await pending, [])

  clock.value += 10
  await setReplies(bridge, true)
  worker.setThread(thread({ messages: [message({ id: '3002', timestamp: clock.value + 1 })] }))
  await waitFor(() => published.some((item) => item.id === '3002'))
  barrier = worker.blockNextThread()
  const sending = bridge.sendText({
    chatId: `instagram_private:${ACCOUNT_ID}:dm:4001`,
    sourceMessageId: '3002',
    text: 'reply',
    idempotencyKey: 'pause-race'
  })
  await barrier.entered
  await setReplies(bridge, false)
  barrier.release()
  await assert.rejects(sending, /paused/)
  assert.equal(worker.calls.filter((call) => call.operation === 'send_text').length, 0)
})

test('stores paused observations but a fresh resume cutoff prevents history backfill', async (t) => {
  const { bridge, clock, worker } = await fixture(t)
  worker.setThread(thread())
  await configure(bridge)
  await waitFor(() => bridge.getConsoleState().users.some((user) => user.senderId === OWNER_SENDER))
  assert.deepEqual(await bridge.getPendingReplies({ after: 0 }), [])
  clock.value += 10
  await setReplies(bridge, true)
  assert.deepEqual(await bridge.getPendingReplies({ after: 0 }), [])
})
