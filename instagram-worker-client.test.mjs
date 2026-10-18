import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

import { InstagramWorkerClient } from './instagram-worker-client.mjs'

function fakeSpawn(handler) {
  const calls = []
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = (signal) => {
      child.killed = true
      child.signal = signal
      queueMicrotask(() => child.emit('exit', null, signal))
      return true
    }
    let input = ''
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        input += chunk.toString()
        while (input.includes('\n')) {
          const newline = input.indexOf('\n')
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          handler({ request: JSON.parse(line), child })
        }
        callback()
      }
    })
    calls.push({ executable, args, options, child })
    return child
  }
  return { calls, spawnImpl }
}

test('uses the flat JSONL worker protocol, safe environment, and sequential requests', async () => {
  const seen = []
  const transport = fakeSpawn(({ request, child }) => {
    seen.push(request)
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: request.operation === 'status'
        ? { status: 'connected', account: { id: '1001', username: 'dot' } }
        : { account: { id: '1001', username: 'dot' }, threads: [] }
    })}\n`))
  })
  const client = new InstagramWorkerClient({
    dataDir: '/private/runtime',
    expectedAccountId: '1001',
    python: '/opt/python',
    spawnImpl: transport.spawnImpl,
    username: 'dot'
  })
  const first = client.request('status', {})
  const second = client.request('poll', { limit: 20 })
  await Promise.all([first, second])
  assert.deepEqual(seen, [
    { id: '1', operation: 'status' },
    { id: '2', operation: 'poll', limit: 20 }
  ])
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].executable, '/opt/python')
  assert.equal(transport.calls[0].args.length, 1)
  assert.match(transport.calls[0].args[0], /instagram-worker\.py$/)
  assert.equal(transport.calls[0].options.env.DATA_DIR, '/private/runtime')
  assert.equal(transport.calls[0].options.env.INSTAGRAM_EXPECTED_USER_ID, '1001')
  assert.equal(transport.calls[0].options.env.INSTAGRAM_EXPECTED_USERNAME, 'dot')
  assert.equal('INSTAGRAM_PASSWORD' in transport.calls[0].options.env, false)
  await client.stop()
})

test('rejects invalid parameters before spawn and returns sanitized structured worker errors', async () => {
  const transport = fakeSpawn(({ request, child }) => queueMicrotask(() => child.stdout.write(`${JSON.stringify({
    id: request.id,
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'retry later', retryAfter: 1500 }
  })}\n`)))
  const client = new InstagramWorkerClient({ dataDir: '/private/runtime', expectedAccountId: '1001', spawnImpl: transport.spawnImpl })
  await assert.rejects(client.request('poll', { limit: 21 }), (error) => error.code === 'EINVAL')
  assert.equal(transport.calls.length, 0)
  await assert.rejects(client.request('status', {}), (error) => {
    assert.equal(error.code, 'RATE_LIMITED')
    assert.equal(error.message, 'Instagram worker request failed')
    assert.equal(error.retryAfter, 1500)
    return true
  })
  await client.stop()
})

test('stopping destroys active and queued requests without leaking stderr', async () => {
  const transport = fakeSpawn(() => {})
  const client = new InstagramWorkerClient({ dataDir: '/private/runtime', expectedAccountId: '1001', spawnImpl: transport.spawnImpl })
  const active = client.request('status', {})
  const queued = client.request('poll', { limit: 20 })
  transport.calls[0].child.stderr.write('password=secret')
  await client.stop()
  await assert.rejects(active, (error) => error.code === 'ESTOPPED' && !error.message.includes('secret'))
  await assert.rejects(queued, (error) => error.code === 'ESTOPPED')
  assert.equal(transport.calls[0].child.killed, true)
})

test('an old worker exit cannot terminate a replacement process', async () => {
  let spawnCount = 0
  const transport = fakeSpawn(({ request, child }) => {
    spawnCount += 1
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(spawnCount === 1
      ? { id: 'wrong', ok: true, result: {} }
      : { id: request.id, ok: true, result: { status: 'not_configured', account: null } })}\n`))
  })
  const client = new InstagramWorkerClient({ dataDir: '/private/runtime', expectedAccountId: '1001', spawnImpl: transport.spawnImpl })
  await assert.rejects(client.request('status', {}), (error) => error.code === 'EPROTOCOL')
  assert.deepEqual(await client.request('status', {}), { status: 'not_configured', account: null })
  assert.equal(transport.calls.length, 2)
  await client.stop()
})
