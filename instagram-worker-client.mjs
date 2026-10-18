import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_QUEUED = 20
const REQUEST_TIMEOUT_MS = 45_000
const MAX_ID = 2_147_483_647
const OPERATIONS = new Set(['status', 'poll', 'thread', 'send_text', 'send_image'])

function clientError(message, code = 'EWORKER') {
  return Object.assign(new Error(message), { code })
}

function safeEnvironment(dataDir, expectedAccountId, username) {
  const env = { DATA_DIR: dataDir, INSTAGRAM_EXPECTED_USER_ID: expectedAccountId }
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONPATH', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TMPDIR', 'VIRTUAL_ENV']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  if (username) env.INSTAGRAM_EXPECTED_USERNAME = username
  return env
}

function cleanError(value) {
  const code = typeof value?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value.code)
    ? value.code
    : 'EPROVIDER'
  const error = clientError('Instagram worker request failed', code)
  if (Number.isSafeInteger(value?.retryAfter) && value.retryAfter >= 0 && value.retryAfter <= 300_000) {
    error.retryAfter = value.retryAfter
  }
  return error
}

function validParams(operation, params) {
  const keys = Object.keys(params)
  if (keys.some((key) => RESERVED_KEYS.has(key))) return false
  const exact = (allowed) => keys.every((key) => allowed.has(key)) && [...allowed].every((key) => keys.includes(key))
  if (operation === 'status') return keys.length === 0
  if (operation === 'poll') return exact(new Set(['limit'])) && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 20
  if (operation === 'thread') return exact(new Set(['threadId', 'limit'])) && /^[1-9]\d{0,63}$/.test(params.threadId)
    && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 50
  if (operation === 'send_text') return exact(new Set(['threadId', 'sourceMessageId', 'text']))
    && /^[1-9]\d{0,63}$/.test(params.threadId) && typeof params.sourceMessageId === 'string'
    && params.sourceMessageId.length > 0 && params.sourceMessageId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(params.sourceMessageId)
    && typeof params.text === 'string' && params.text.length > 0 && params.text.length <= 2000
  return operation === 'send_image' && exact(new Set(['threadId', 'sourceMessageId', 'data', 'mimetype']))
    && /^[1-9]\d{0,63}$/.test(params.threadId) && typeof params.sourceMessageId === 'string'
    && params.sourceMessageId.length > 0 && params.sourceMessageId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(params.sourceMessageId)
    && typeof params.data === 'string' && params.data.length > 0 && params.data.length <= 6_990_508
    && ['image/png', 'image/jpeg'].includes(params.mimetype)
}

const RESERVED_KEYS = new Set(['id', 'operation', '__proto__', 'constructor', 'prototype'])

export class InstagramWorkerClient {
  constructor({
    dataDir,
    expectedAccountId,
    python = process.env.INSTAGRAM_PYTHON || 'python3',
    spawnImpl = nodeSpawn,
    username = process.env.INSTAGRAM_EXPECTED_USERNAME
  } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required')
    if (typeof expectedAccountId !== 'string' || !/^[1-9]\d{0,63}$/.test(expectedAccountId)) {
      throw new TypeError('expectedAccountId is invalid')
    }
    if (typeof python !== 'string' || python.length === 0 || typeof spawnImpl !== 'function') {
      throw new TypeError('worker process configuration is invalid')
    }
    if (username !== undefined && (typeof username !== 'string' || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username))) {
      throw new TypeError('username is invalid')
    }
    this.dataDir = dataDir
    this.expectedAccountId = expectedAccountId
    this.python = python
    this.spawnImpl = spawnImpl
    this.username = username || null
    this.child = null
    this.queue = []
    this.active = null
    this.nextId = 1
    this.output = Buffer.alloc(0)
    this.stopped = false
  }

  request(operation, params = {}) {
    if (!OPERATIONS.has(operation)) return Promise.reject(clientError('Unsupported Instagram worker operation', 'EINVAL'))
    if (params === null || typeof params !== 'object' || Array.isArray(params) || !validParams(operation, params)) {
      return Promise.reject(clientError('Instagram worker parameters are invalid', 'EINVAL'))
    }
    if (this.stopped) return Promise.reject(clientError('Instagram worker is stopped', 'ESTOPPED'))
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_QUEUED) {
      return Promise.reject(clientError('Instagram worker queue is full', 'EQUEUEFULL'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, params: structuredClone(params), resolve, reject })
      this.#drain()
    })
  }

  async stop() {
    this.stopped = true
    const error = clientError('Instagram worker stopped', 'ESTOPPED')
    if (this.active) {
      clearTimeout(this.active.timer)
      this.active.reject(error)
      this.active = null
    }
    for (const item of this.queue.splice(0)) item.reject(error)
    const child = this.child
    this.child = null
    this.output = Buffer.alloc(0)
    if (child && !child.killed) child.kill('SIGTERM')
  }

  #spawn() {
    if (this.child) return this.child
    const script = fileURLToPath(new URL('./instagram-worker.py', import.meta.url))
    const child = this.spawnImpl(this.python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnvironment(this.dataDir, this.expectedAccountId, this.username)
    })
    this.child = child
    this.output = Buffer.alloc(0)
    child.stdout?.on('data', (chunk) => {
      if (this.child === child) this.#onOutput(chunk)
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      if (this.child === child) this.#failProcess(clientError('Instagram worker could not start', 'EWORKERSTART'))
    })
    child.on('exit', () => {
      if (this.child === child) this.#failProcess(clientError('Instagram worker exited', 'EWORKEREXIT'))
    })
    return child
  }

  #drain() {
    if (this.active || this.queue.length === 0 || this.stopped) return
    const queued = this.queue.shift()
    let child
    try {
      child = this.#spawn()
    } catch {
      queued.reject(clientError('Instagram worker could not start', 'EWORKERSTART'))
      queueMicrotask(() => this.#drain())
      return
    }
    const id = String(this.nextId)
    this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1
    const timer = setTimeout(() => {
      if (this.active?.id !== id) return
      const active = this.active
      this.active = null
      active.reject(clientError('Instagram worker request timed out', 'ETIMEDOUT'))
      this.#resetProcess()
      this.#drain()
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    this.active = { ...queued, id, timer }
    const line = `${JSON.stringify({ id, operation: queued.operation, ...queued.params })}\n`
    try {
      child.stdin.write(line, (error) => {
        if (error && this.child === child && this.active?.id === id) {
          this.#failProcess(clientError('Instagram worker input failed', 'EWORKERWRITE'))
        }
      })
    } catch {
      this.#failProcess(clientError('Instagram worker input failed', 'EWORKERWRITE'))
    }
  }

  #onOutput(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
    this.output = Buffer.concat([this.output, chunk])
    if (this.output.length > MAX_LINE_BYTES && this.output.indexOf(0x0a) < 0) {
      this.#failProcess(clientError('Instagram worker output is too large', 'EOUTPUT'))
      return
    }
    while (true) {
      const newline = this.output.indexOf(0x0a)
      if (newline < 0) break
      if (newline > MAX_LINE_BYTES) {
        this.#failProcess(clientError('Instagram worker output is too large', 'EOUTPUT'))
        return
      }
      const line = this.output.subarray(0, newline).toString('utf8')
      this.output = this.output.subarray(newline + 1)
      this.#onLine(line)
      if (!this.child) return
    }
  }

  #onLine(line) {
    const active = this.active
    if (!active) return
    let response
    try { response = JSON.parse(line) } catch {
      this.#failProcess(clientError('Instagram worker returned invalid data', 'EPROTOCOL'))
      return
    }
    const keys = response && typeof response === 'object' && !Array.isArray(response) ? Object.keys(response) : []
    const valid = response?.id === active.id && typeof response.ok === 'boolean'
      && keys.every((key) => ['id', 'ok', 'result', 'error'].includes(key))
      && (response.ok ? keys.includes('result') && !keys.includes('error') : keys.includes('error') && !keys.includes('result'))
    if (!valid) {
      this.#failProcess(clientError('Instagram worker returned invalid data', 'EPROTOCOL'))
      return
    }
    clearTimeout(active.timer)
    this.active = null
    if (response.ok) active.resolve(response.result)
    else active.reject(cleanError(response.error))
    this.#drain()
  }

  #resetProcess() {
    const child = this.child
    this.child = null
    this.output = Buffer.alloc(0)
    if (child && !child.killed) child.kill('SIGKILL')
  }

  #failProcess(error) {
    const active = this.active
    this.active = null
    if (active) {
      clearTimeout(active.timer)
      active.reject(error)
    }
    this.#resetProcess()
    queueMicrotask(() => this.#drain())
  }
}
