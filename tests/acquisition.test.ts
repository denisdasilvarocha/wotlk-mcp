import { execFileSync, execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'
import * as z from 'zod'

const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-acquire-'))
const dbPath = path.join(dir, 'reference.sqlite')
const preload = path.join(dir, 'redirect.mjs')
let data: Buffer
let base: string
let scenario = 'good'
let requests: string[] = []
let authorization = ''
const download = { finish: (): void => {} }
const metadata = { hold: false, finish: (): void => {} }
const concurrent: ServerResponse[] = []
const server = createServer((req, res) => {
  requests.push(req.url ?? '')
  authorization = req.headers.authorization ?? ''
  if (scenario === 'offline') {
    res.writeHead(503).end()
    return
  }
  if (scenario === '403' || scenario === '429') {
    res.writeHead(Number(scenario)).end()
    return
  }
  if (req.url === '/releases') {
    let digest: string | undefined = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (scenario === 'missing') digest = undefined
    if (scenario === 'bad') digest = `sha256:${'0'.repeat(64)}`
    const asset = { name: 'wotlk.sqlite.br', digest, browser_download_url: `${base}/asset` }
    res.setHeader('content-type', 'application/json')
    const releases = [
      { tag_name: 'v9.0.0', prerelease: false, draft: false, assets: [] },
      { tag_name: 'db-v2.0.0', prerelease: false, draft: false, assets: [asset] }
    ]
    let version = 'db-v1.2.0'
    if (scenario === 'rollback') version = 'db-v1.1.0'
    if (scenario !== 'higher')
      releases.push(
        { tag_name: 'db-v1.9.0', prerelease: true, draft: false, assets: [] },
        { tag_name: version, prerelease: false, draft: false, assets: [asset] }
      )
    const body = JSON.stringify(releases)
    if (metadata.hold)
      metadata.finish = (): void => {
        metadata.finish = (): void => {}
        res.end(body)
      }
    else res.end(body)
  } else {
    res.setHeader('content-length', data.length)
    if (scenario === 'slow') {
      res.write(data.subarray(0, 10))
      download.finish = (): void => {
        res.end(data.subarray(10))
      }
    } else if (scenario === 'concurrent') {
      concurrent.push(res)
      if (concurrent.length === 2) for (const response of concurrent.splice(0)) response.end(data)
    } else res.end(data)
  }
})

beforeAll(async () => {
  execSync(`vpx scripts/build-reference.ts "${dbPath}"`)
  execSync(`vp pm pack --pack-destination "${dir}"`)
  const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(dir, archive), '-C', dir])
  symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'junction')
  data = brotliCompressSync(readFileSync(dbPath))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  base = `http://127.0.0.1:${address.port}`
  writeFileSync(
    preload,
    `const original = globalThis.fetch; globalThis.fetch = (url, options) => original(String(url).startsWith('https://api.github.com/') ? process.env.TEST_RELEASES : url, options); if (process.env.TEST_NOW) Date.now = () => Number(process.env.TEST_NOW)`
  )
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function launch(extra: Record<string, string> = {}, homeCache = false): Promise<Client> {
  const cache = mkdtempSync(path.join(dir, 'cache-'))
  const client = new Client({ name: 'acquisition-test', version: '1' })
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
    HOME: cache,
    XDG_CACHE_HOME: cache,
    LOCALAPPDATA: cache,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    TEST_RELEASES: `${base}/releases`,
    ...extra
  }
  if (homeCache) delete env.XDG_CACHE_HOME
  delete env.WOTLK_MCP_DB
  if (extra.WOTLK_MCP_DB) env.WOTLK_MCP_DB = extra.WOTLK_MCP_DB
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dir, 'package/dist/index.mjs')],
      env
    })
  )
  return client
}
function call(client: Client): ReturnType<Client['callTool']> {
  return client.callTool({ name: 'get', arguments: { ids: ['offset:Globals::PlayerName'] } })
}
async function marker(client: Client): Promise<string> {
  return JSON.stringify(
    await client.callTool({
      name: 'sql',
      arguments: { query: "SELECT value FROM meta WHERE key = 'lifecycle_marker'" }
    })
  )
}

test('acquires the newest compatible published reference and uses optional token', async () => {
  scenario = 'good'
  requests = []
  const client = await launch({ GITHUB_TOKEN: 'example-token' })
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('get')
    expect((await call(client)).isError).not.toBe(true)
    expect(requests).toEqual(['/releases', '/asset'])
    expect(authorization).toBe('Bearer example-token')
  } finally {
    await client.close()
  }
})

test.skipIf(process.platform !== 'linux')(
  'Linux uses the home cache when XDG_CACHE_HOME is absent',
  async () => {
    const home = mkdtempSync(path.join(dir, 'home-'))
    scenario = 'good'
    const first = await launch({ HOME: home }, true)
    try {
      expect((await call(first)).isError).not.toBe(true)
    } finally {
      await first.close()
    }
    expect(
      readdirSync(path.join(home, '.cache', 'wotlk-mcp')).some((name) => name.startsWith('state-'))
    ).toBe(true)
    scenario = 'offline'
    const second = await launch({ HOME: home }, true)
    try {
      expect((await call(second)).isError).not.toBe(true)
    } finally {
      await second.close()
    }
  }
)

test('shared cache survives concurrent first downloads and offline restarts', async () => {
  const cache = mkdtempSync(path.join(dir, 'shared-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  scenario = 'concurrent'
  const clients = await Promise.all([launch(env), launch(env)])
  try {
    const results = await Promise.all(clients.map(call))
    expect(results.every((result) => !result.isError)).toBe(true)
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
  scenario = 'offline'
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  const stateFiles = readdirSync(directory)
    .filter((name) => name.startsWith('state-'))
    .toSorted()
  expect(stateFiles).toHaveLength(2)
  const current = z
    .object({ file: z.string(), version: z.string(), lastCheck: z.number() })
    .parse(JSON.parse(readFileSync(path.join(directory, stateFiles[1]), 'utf8')))
  expect(current.version).toBe('db-v1.2.0')
  expect(current.lastCheck).toBeGreaterThan(0)
  writeFileSync(path.join(directory, current.file), 'corrupt')
  const abandoned = path.join(directory, '99999999-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.br.partial')
  writeFileSync(abandoned, 'partial')
  utimesSync(abandoned, new Date(0), new Date(0))
  requests = []
  const offline = await launch(env)
  try {
    expect((await call(offline)).isError).not.toBe(true)
    expect(requests).toEqual([])
    expect(readdirSync(directory)).not.toContain(path.basename(abandoned))
  } finally {
    await offline.close()
  }
})

test('another process pruning old copies preserves a live session snapshot', async () => {
  const cache = mkdtempSync(path.join(dir, 'active-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  scenario = 'good'
  const active = await launch(env)
  try {
    expect((await call(active)).isError).not.toBe(true)
    const names = readdirSync(directory)
    const snapshot = names.find((name) => name.startsWith('session-'))
    const stateName = names.find((name) => name.startsWith('state-'))
    if (!snapshot || !stateName) throw new Error('missing active snapshot or state')
    const state = z
      .object({ file: z.string(), version: z.string(), lastCheck: z.number() })
      .parse(JSON.parse(readFileSync(path.join(directory, stateName), 'utf8')))
    for (const suffix of [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    ]) {
      const file = `db-v1.2.0-99999999-${suffix}.sqlite`
      copyFileSync(path.join(directory, state.file), path.join(directory, file))
      writeFileSync(
        path.join(directory, `state-${Date.now() + 10000}-${suffix}.json`),
        JSON.stringify({ ...state, file })
      )
    }
    utimesSync(path.join(directory, stateName), new Date(0), new Date(0))
    utimesSync(path.join(directory, state.file), new Date(0), new Date(0))
    scenario = 'offline'
    const other = await launch(env)
    try {
      expect((await call(other)).isError).not.toBe(true)
      expect(existsSync(path.join(directory, snapshot))).toBe(true)
      expect((await call(active)).isError).not.toBe(true)
    } finally {
      await other.close()
    }
  } finally {
    await active.close()
  }
})

test.skipIf(process.platform !== 'win32')(
  'Windows sharing violations do not prevent offline startup',
  async () => {
    const cache = mkdtempSync(path.join(dir, 'locked-'))
    const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
    scenario = 'good'
    const initial = await launch(env)
    expect((await call(initial)).isError).not.toBe(true)
    await initial.close()
    const directory = path.join(cache, 'wotlk-mcp')
    const locked = path.join(
      directory,
      'db-v1.0.0-99999999-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.sqlite'
    )
    writeFileSync(locked, 'locked')
    utimesSync(locked, new Date(0), new Date(0))
    const holder = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$f=[System.IO.File]::Open($env:LOCK_FILE,'Open','Read','None'); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()"
      ],
      { env: { ...process.env, LOCK_FILE: locked }, stdio: ['pipe', 'pipe', 'inherit'] }
    )
    try {
      const [ready] = await once(holder.stdout, 'data')
      expect(String(ready)).toContain('ready')
      scenario = 'offline'
      const client = await launch(env)
      try {
        expect((await call(client)).isError).not.toBe(true)
        expect(existsSync(locked)).toBe(true)
      } finally {
        await client.close()
      }
    } finally {
      holder.stdin.end('\n')
      await once(holder, 'exit')
    }
    const afterRelease = await launch(env)
    try {
      expect((await call(afterRelease)).isError).not.toBe(true)
      expect(existsSync(locked)).toBe(false)
    } finally {
      await afterRelease.close()
    }
  }
)

test('an interrupted download leaves no usable partial and a later start recovers', async () => {
  const cache = mkdtempSync(path.join(dir, 'interrupted-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  scenario = 'slow'
  const client = await launch(env)
  async function waitForPartial(remaining: number): Promise<string> {
    if (existsSync(directory)) {
      const partial = readdirSync(directory).find((name) => name.endsWith('.br.partial'))
      if (partial) return partial
    }
    if (!remaining) throw new Error('download partial was not created')
    await delay(20)
    return waitForPartial(remaining - 1)
  }
  const partial = await waitForPartial(250)
  await client.close()
  download.finish()
  expect(readdirSync(directory).some((name) => name.startsWith('state-'))).toBe(false)
  utimesSync(path.join(directory, partial), new Date(0), new Date(0))
  scenario = 'good'
  const restarted = await launch(env)
  try {
    expect((await call(restarted)).isError).not.toBe(true)
    expect(readdirSync(directory)).not.toContain(partial)
  } finally {
    await restarted.close()
  }
})

test.each(['bad', 'missing', 'offline', 'broken', 'schema'])(
  'rejects %s acquisition',
  async (mode) => {
    scenario = mode
    const original = data
    if (mode === 'broken') data = Buffer.from('not brotli')
    if (mode === 'schema') {
      const newer = path.join(dir, 'newer.sqlite')
      const db = new DatabaseSync(newer)
      db.exec(
        "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('schema_version', '2.0.0')"
      )
      db.close()
      data = brotliCompressSync(readFileSync(newer))
    }
    const client = await launch()
    try {
      const result = await call(client)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('no reference database: download failed')
    } finally {
      await client.close()
      data = original
    }
  }
)

test('higher-major-only releases name the required package major', async () => {
  scenario = 'higher'
  requests = []
  const client = await launch()
  try {
    expect(JSON.stringify(await call(client))).toContain('wotlk-mcp@2')
    expect(requests).toEqual(['/releases'])
  } finally {
    await client.close()
  }
})

test('cached higher-major guidance reaches one result without blocking the session', async () => {
  const cache = mkdtempSync(path.join(dir, 'update-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  scenario = 'good'
  const initial = await launch(env)
  expect((await call(initial)).isError).not.toBe(true)
  await initial.close()
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  const state = readdirSync(directory).find((name) => name.startsWith('state-'))
  if (!state) throw new Error('missing cache state')
  const old = z
    .object({ file: z.string(), version: z.string() })
    .parse(JSON.parse(readFileSync(path.join(directory, state), 'utf8')))
  writeFileSync(path.join(directory, state), JSON.stringify({ ...old, lastCheck: 0 }))
  requests = []
  scenario = 'higher'
  metadata.hold = true
  const cached = await launch(env)
  try {
    const first = await call(cached)
    expect(first.isError).not.toBe(true)
    expect(JSON.stringify(first)).not.toContain('note: newer reference data')
    async function waitForMetadata(remaining: number): Promise<void> {
      if (requests.includes('/releases')) return
      if (!remaining) throw new Error('update request did not start')
      await delay(10)
      await waitForMetadata(remaining - 1)
    }
    await waitForMetadata(200)
    metadata.finish()
    async function guidance(remaining: number): Promise<void> {
      const result = JSON.stringify(await call(cached))
      if (result.includes('note: newer reference data needs wotlk-mcp@2; update your config'))
        return
      if (!remaining) throw new Error('missing update guidance')
      await delay(10)
      await guidance(remaining - 1)
    }
    await guidance(200)
    expect(requests).toContain('/releases')
    expect(JSON.stringify(await call(cached))).not.toContain('note: newer reference data')
    async function waitForJournal(remaining: number): Promise<void> {
      const saved = readdirSync(directory).some((name) => {
        if (!name.startsWith('state-')) return false
        const entry = z
          .object({ warningMajor: z.number().optional() })
          .parse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
        return entry.warningMajor === 2
      })
      if (saved) return
      if (!remaining) throw new Error('update journal was not saved')
      await delay(10)
      await waitForJournal(remaining - 1)
    }
    await waitForJournal(200)
  } finally {
    metadata.hold = false
    metadata.finish()
    await cached.close()
  }
  const restarted = await launch(env)
  try {
    expect(JSON.stringify(await call(restarted))).toContain(
      'note: newer reference data needs wotlk-mcp@2; update your config'
    )
    expect(JSON.stringify(await call(restarted))).not.toContain('note: newer reference data')
  } finally {
    await restarted.close()
  }
})

test('a published rollback is activated at the next process start', async () => {
  const cache = mkdtempSync(path.join(dir, 'rollback-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  const original = data
  const replacement = path.join(dir, 'rollback.sqlite')
  copyFileSync(dbPath, replacement)
  const db = new DatabaseSync(replacement)
  db.exec("INSERT INTO meta (key, value) VALUES ('lifecycle_marker', 'rollback')")
  db.close()
  scenario = 'good'
  const first = await launch(env)
  expect((await call(first)).isError).not.toBe(true)
  await first.close()
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  const stateName = readdirSync(directory).find((name) => name.startsWith('state-'))
  if (!stateName) throw new Error('missing initial cache state')
  const state = z
    .object({ file: z.string(), version: z.string() })
    .parse(JSON.parse(readFileSync(path.join(directory, stateName), 'utf8')))
  writeFileSync(path.join(directory, stateName), JSON.stringify({ ...state, lastCheck: 0 }))
  data = brotliCompressSync(readFileSync(replacement))
  scenario = 'rollback'
  const active = await launch(env)
  async function waitForPromotion(remaining: number): Promise<void> {
    const names = readdirSync(directory)
      .filter((name) => name.startsWith('state-'))
      .toSorted()
    const latest = names.at(-1)
    if (latest) {
      const entry = z
        .object({ version: z.string() })
        .parse(JSON.parse(readFileSync(path.join(directory, latest), 'utf8')))
      if (entry.version === 'db-v1.1.0') return
    }
    if (!remaining) throw new Error('rollback was not promoted')
    await delay(10)
    await waitForPromotion(remaining - 1)
  }
  try {
    expect(await marker(active)).not.toContain('rollback')
    await waitForPromotion(500)
    expect(await marker(active)).not.toContain('rollback')
    const next = await launch(env)
    try {
      expect(await marker(next)).toContain('rollback')
    } finally {
      await next.close()
    }
    const currentName = readdirSync(directory)
      .filter((name) => name.startsWith('state-'))
      .toSorted()
      .at(-1)
    if (!currentName) throw new Error('missing promoted cache state')
    const current = z
      .object({ file: z.string(), version: z.string() })
      .parse(JSON.parse(readFileSync(path.join(directory, currentName), 'utf8')))
    const clock = 2_000_000_000_000
    scenario = 'offline'
    const checker = await launch({ ...env, TEST_NOW: String(clock) })
    expect(await marker(checker)).toContain('rollback')
    async function waitForFailure(remaining: number): Promise<void> {
      if (readdirSync(directory).some((name) => name.startsWith(`state-${clock + 1}-`))) return
      if (!remaining) throw new Error('failed check was not saved')
      await delay(10)
      await waitForFailure(remaining - 1)
    }
    await waitForFailure(500)
    await checker.close()
    const pruner = await launch({ ...env, TEST_NOW: String(clock + 1) })
    expect(await marker(pruner)).toContain('rollback')
    await pruner.close()
    writeFileSync(path.join(directory, current.file), 'corrupt')
    const fallback = await launch({ ...env, TEST_NOW: String(clock + 2) })
    try {
      expect((await call(fallback)).isError).not.toBe(true)
      expect(await marker(fallback)).not.toContain('rollback')
    } finally {
      await fallback.close()
    }
  } finally {
    await active.close()
    data = original
  }
})

test('failed checks persist the full 24-hour attempt window', async () => {
  const cache = mkdtempSync(path.join(dir, 'clock-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  const start = 2_000_000_000_000
  const day = 24 * 60 * 60 * 1000
  scenario = 'good'
  const initial = await launch({ ...env, TEST_NOW: String(start) })
  expect((await call(initial)).isError).not.toBe(true)
  await initial.close()
  let root = cache
  if (process.platform === 'darwin') root = path.join(cache, 'Library', 'Caches')
  const directory = path.join(root, 'wotlk-mcp')
  async function waitForCheck(timestamp: number, remaining: number): Promise<void> {
    if (
      requests.includes('/releases') &&
      readdirSync(directory).some((name) => name.startsWith(`state-${timestamp + 1}-`))
    )
      return
    if (!remaining) throw new Error('update check did not finish')
    await delay(10)
    await waitForCheck(timestamp, remaining - 1)
  }
  scenario = '403'
  requests = []
  const early = await launch({ ...env, TEST_NOW: String(start + day - 1) })
  expect((await call(early)).isError).not.toBe(true)
  await delay(100)
  expect(requests).toEqual([])
  await early.close()
  const boundaries = await Promise.all([
    launch({ ...env, TEST_NOW: String(start + day) }),
    launch({ ...env, TEST_NOW: String(start + day) })
  ])
  expect((await Promise.all(boundaries.map(call))).every((result) => !result.isError)).toBe(true)
  await waitForCheck(start + day, 500)
  expect(requests).toEqual(['/releases'])
  await Promise.all(boundaries.map((client) => client.close()))
  requests = []
  scenario = '429'
  const throttled = await launch({ ...env, TEST_NOW: String(start + day + 1) })
  expect((await call(throttled)).isError).not.toBe(true)
  await delay(100)
  expect(requests).toEqual([])
  await throttled.close()
  const retry = await launch({ ...env, TEST_NOW: String(start + 2 * day) })
  expect((await call(retry)).isError).not.toBe(true)
  await waitForCheck(start + 2 * day, 500)
  expect(requests).toEqual(['/releases'])
  await retry.close()
})

test('invalid override never contacts the network', async () => {
  scenario = 'good'
  requests = []
  const client = await launch({ WOTLK_MCP_DB: path.join(dir, 'absent.sqlite') })
  try {
    expect(JSON.stringify(await call(client))).toContain('invalid WOTLK_MCP_DB')
    expect(requests).toEqual([])
  } finally {
    await client.close()
  }
})

test('discovery stays available and a slow download continues after the bounded wait', async () => {
  scenario = 'slow'
  requests = []
  download.finish = (): void => {}
  const client = await launch()
  try {
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    const result = await call(client)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/downloading.*10.*retry/i)
    download.finish()
    expect((await call(client)).isError).not.toBe(true)
  } finally {
    download.finish()
    await client.close()
  }
}, 30000)
