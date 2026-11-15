import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

import { initReference } from '../build/offsets.ts'
import { unpackPackage } from './package.ts'

let authorization = ''
let base: string
const concurrent: ServerResponse[] = []
let data: Buffer
const download = { finish: (): void => {} }
const metadata = { hold: false, finish: (): void => {} }
let newerData: Buffer
let olderData: Buffer
let requests: string[] = []
let scenario = 'good'
const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-acquire-'))
const dbPath = path.join(dir, 'reference.sqlite')
const preload = path.join(dir, 'redirect.mjs')

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

  if (req.url === '/releases' || req.url === '/page2') {
    let digest: string | undefined = `sha256:${createHash('sha256').update(data).digest('hex')}`

    if (scenario === 'missing') digest = undefined

    if (scenario === 'bad') digest = `sha256:${'0'.repeat(64)}`

    const asset = { name: 'wotlk.sqlite.br', digest, url: `${base}/asset` }

    if (scenario === 'selection') {
      const releases = [
        {
          tag_name: 'db-v1.9.0',
          published_at: '2025-01-01T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [
            {
              ...asset,
              digest: `sha256:${createHash('sha256').update(olderData).digest('hex')}`,
              url: `${base}/older`
            }
          ]
        },
        {
          tag_name: 'db-v1.1.0',
          published_at: '2025-02-01T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [
            {
              ...asset,
              digest: `sha256:${createHash('sha256').update(newerData).digest('hex')}`,
              url: `${base}/newer`
            }
          ]
        }
      ]

      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(releases))

      return
    }

    res.setHeader('content-type', 'application/json')

    const releases = [
      { tag_name: 'v9.0.0', prerelease: false, draft: false, assets: [] },
      { tag_name: 'db-v2.0.0', prerelease: false, draft: false, assets: [asset] }
    ]
    let version = 'db-v1.2.0'

    if (scenario === 'pagination' && req.url === '/releases') {
      res.setHeader('link', `<${base}/page2>; rel="next"`)
      res.end(JSON.stringify(releases))

      return
    }

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
    // The GitHub asset API returns JSON metadata unless binary content is requested.
    if (req.headers.accept !== 'application/octet-stream') {
      res.writeHead(415).end()
      return
    }

    if (scenario === 'selection') {
      if (req.url === '/newer') res.end(newerData)
      else res.end(olderData)

      return
    }

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
  initReference(dbPath)
  unpackPackage(dir)
  data = brotliCompressSync(readFileSync(dbPath))

  for (const name of ['older', 'newer']) {
    const file = path.join(dir, `${name}.sqlite`)

    copyFileSync(dbPath, file)

    const db = new DatabaseSync(file)

    db.prepare("INSERT INTO meta (key, value) VALUES ('lifecycle_marker', ?)").run(name)
    db.close()

    if (name === 'older') olderData = brotliCompressSync(readFileSync(file))
    else newerData = brotliCompressSync(readFileSync(file))
  }

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

function cacheDirectory(cache: string): string {
  if (process.platform === 'darwin')
    return path.join(cache, 'Library', 'Caches', 'wotlk-mcp', 'schema-1')

  return path.join(cache, 'wotlk-mcp', 'schema-1')
}

function cacheStates(directory: string): {
  name: string
  file: string
  version: string
  lastCheck: number
  warningMajor?: number
}[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith('state-'))
    .toSorted()
    .map((name) => {
      const state = z
        .object({
          file: z.string(),
          version: z.string(),
          lastCheck: z.number(),
          warningMajor: z.number().optional()
        })
        .parse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')))

      return {
        name,
        file: state.file,
        version: state.version,
        lastCheck: state.lastCheck,
        warningMajor: state.warningMajor
      }
    })
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  message: string,
  remaining = 500
): Promise<void> {
  if (await check()) return
  if (!remaining) throw new Error(message)

  await delay(10)
  await waitUntil(check, message, remaining - 1)
}

test('acquires the newest compatible published reference and uses optional token', async () => {
  scenario = 'selection'
  requests = []

  const client = await launch({ GITHUB_TOKEN: 'example-token' })

  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('get')
    expect(await marker(client)).toContain('newer')
    expect(requests).toEqual(['/releases', '/newer'])
    expect(authorization).toBe('Bearer example-token')
  } finally {
    await client.close()
  }
})
test('retries a failed acquisition in the same session and shares the new attempt', async () => {
  scenario = '429'
  requests = []

  const client = await launch()

  try {
    const failed = await call(client)

    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('HTTP 429')
    expect(requests).toEqual(['/releases'])
    scenario = 'good'
    requests = []

    const results = await Promise.all([call(client), call(client)])

    expect(results.every((result) => !result.isError)).toBe(true)
    expect((await call(client)).isError).not.toBe(true)
    expect(requests).toEqual(['/releases', '/asset'])
  } finally {
    await client.close()
  }
})
test('a failed session recovers offline after another process populates the cache', async () => {
  const cache = mkdtempSync(path.join(dir, 'recovered-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }

  scenario = 'offline'

  const client = await launch(env)

  try {
    expect((await call(client)).isError).toBe(true)
    scenario = 'good'

    const other = await launch(env)

    try {
      expect((await call(other)).isError).not.toBe(true)
    } finally {
      await other.close()
    }

    scenario = 'offline'
    requests = []
    expect((await call(client)).isError).not.toBe(true)
    expect(requests).toEqual([])
  } finally {
    await client.close()
  }
})
test('fresh acquisition follows release pages and persists once-per-session major guidance', async () => {
  const cache = mkdtempSync(path.join(dir, 'paginated-'))
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }

  scenario = 'pagination'
  requests = []

  const first = await launch(env)

  try {
    expect(JSON.stringify(await call(first))).toContain(
      'note: newer reference data needs wotlk-mcp@2'
    )
    expect(JSON.stringify(await call(first))).not.toContain('note: newer reference data')
    expect(requests).toEqual(['/releases', '/page2', '/asset'])
  } finally {
    await first.close()
  }

  scenario = 'offline'

  const second = await launch(env)

  try {
    expect(JSON.stringify(await call(second))).toContain(
      'note: newer reference data needs wotlk-mcp@2'
    )
    expect(JSON.stringify(await call(second))).not.toContain('note: newer reference data')
  } finally {
    await second.close()
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

  const directory = cacheDirectory(cache)
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
  const directory = cacheDirectory(cache)

  scenario = 'good'

  const active = await launch(env)

  try {
    expect((await call(active)).isError).not.toBe(true)

    const names = readdirSync(directory)
    const snapshot = names.find((name) => name.startsWith('session-'))
    const state = cacheStates(directory).at(-1)

    if (!snapshot || !state) throw new Error('missing active snapshot or state')

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

    utimesSync(path.join(directory, state.name), new Date(0), new Date(0))
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

    const directory = cacheDirectory(cache)
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
  const directory = cacheDirectory(cache)

  scenario = 'slow'

  const client = await launch(env)

  await waitUntil(
    () =>
      existsSync(directory) && readdirSync(directory).some((name) => name.endsWith('.br.partial')),
    'download partial was not created'
  )

  const partial = readdirSync(directory).find((name) => name.endsWith('.br.partial'))

  if (!partial) throw new Error('download partial disappeared')

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
      const newer = path.join(dir, 'schema-invalid.sqlite')
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

  const directory = cacheDirectory(cache)
  const old = cacheStates(directory).at(-1)

  if (!old) throw new Error('missing cache state')

  writeFileSync(path.join(directory, old.name), JSON.stringify({ ...old, lastCheck: 0 }))
  requests = []
  scenario = 'higher'
  metadata.hold = true

  const cached = await launch(env)

  try {
    const first = await call(cached)

    expect(first.isError).not.toBe(true)

    const results = [JSON.stringify(first)]

    await waitUntil(() => requests.includes('/releases'), 'update request did not start')
    metadata.finish()

    if (!results[0].includes('note: newer reference data'))
      await waitUntil(async () => {
        results.push(JSON.stringify(await call(cached)))

        return (
          results
            .at(-1)
            ?.includes('note: newer reference data needs wotlk-mcp@2; update your config') ?? false
        )
      }, 'missing update guidance')

    expect(requests).toContain('/releases')
    results.push(JSON.stringify(await call(cached)))
    expect(
      results.filter((result) =>
        result.includes('note: newer reference data needs wotlk-mcp@2; update your config')
      )
    ).toHaveLength(1)
    await waitUntil(
      () => cacheStates(directory).some((entry) => entry.warningMajor === 2),
      'update journal was not saved'
    )
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
  data = olderData
  scenario = 'good'

  const first = await launch(env)

  expect(await marker(first)).toContain('older')
  await first.close()

  const directory = cacheDirectory(cache)
  const state = cacheStates(directory).at(-1)

  if (!state) throw new Error('missing initial cache state')

  writeFileSync(path.join(directory, state.name), JSON.stringify({ ...state, lastCheck: 0 }))
  data = brotliCompressSync(readFileSync(replacement))
  scenario = 'rollback'
  requests = []

  const active = await launch(env)

  try {
    expect(await marker(active)).toContain('older')
    await waitUntil(
      () => cacheStates(directory).at(-1)?.version === 'db-v1.1.0',
      'rollback was not promoted'
    )
    expect(await marker(active)).toContain('older')
    expect(requests).toEqual(['/releases', '/asset'])

    const next = await launch(env)

    try {
      expect(await marker(next)).toContain('rollback')
    } finally {
      await next.close()
    }

    const current = cacheStates(directory).at(-1)

    if (!current) throw new Error('missing promoted cache state')

    const clock = 2_000_000_000_000

    scenario = 'offline'
    requests = []

    const checker = await launch({ ...env, TEST_NOW: String(clock) })

    expect(await marker(checker)).toContain('rollback')
    await waitUntil(
      () =>
        requests.includes('/releases') &&
        cacheStates(directory).some((entry) => entry.lastCheck === clock),
      'failed check was not saved'
    )
    expect(requests).toEqual(['/releases'])
    await checker.close()

    const pruner = await launch({ ...env, TEST_NOW: String(clock + 1) })

    expect(await marker(pruner)).toContain('rollback')
    await pruner.close()
    requests = []
    writeFileSync(path.join(directory, current.file), 'corrupt')

    const fallback = await launch({ ...env, TEST_NOW: String(clock + 2) })

    try {
      expect((await call(fallback)).isError).not.toBe(true)
      expect(await marker(fallback)).toContain('older')
      await waitUntil(
        () => requests.includes('/releases'),
        'older fallback check was not attempted'
      )
      expect(requests).toEqual(['/releases'])
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
  const day = 24 * 60 * 60 * 1000
  const env = { HOME: cache, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }
  const start = 2_000_000_000_000

  scenario = 'good'

  const initial = await launch({ ...env, TEST_NOW: String(start) })

  expect((await call(initial)).isError).not.toBe(true)
  await initial.close()

  const directory = cacheDirectory(cache)

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
  await waitUntil(
    () =>
      requests.includes('/releases') &&
      cacheStates(directory).some((entry) => entry.lastCheck === start + day),
    'update check did not finish'
  )
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
  await waitUntil(
    () =>
      requests.includes('/releases') &&
      cacheStates(directory).some((entry) => entry.lastCheck === start + 2 * day),
    'retry check did not finish'
  )
  expect(requests).toEqual(['/releases'])
  await retry.close()
}, 20000)

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
