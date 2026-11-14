import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
const concurrent: ServerResponse[] = []
const server = createServer((req, res) => {
  requests.push(req.url ?? '')
  authorization = req.headers.authorization ?? ''
  if (scenario === 'offline') {
    res.writeHead(503).end()
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
    if (scenario !== 'higher')
      releases.push(
        { tag_name: 'db-v1.9.0', prerelease: true, draft: false, assets: [] },
        { tag_name: 'db-v1.2.0', prerelease: false, draft: false, assets: [asset] },
        { tag_name: 'db-v1.1.0', prerelease: false, draft: false, assets: [] }
      )
    res.end(JSON.stringify(releases))
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
  execFileSync('vpx', ['scripts/build-reference.ts', dbPath])
  execFileSync('vp', ['pm', 'pack', '--pack-destination', dir])
  const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(dir, archive), '-C', dir])
  symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'dir')
  data = brotliCompressSync(readFileSync(dbPath))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  base = `http://127.0.0.1:${address.port}`
  writeFileSync(
    preload,
    `const original = globalThis.fetch; globalThis.fetch = (url, options) => original(String(url).startsWith('https://api.github.com/') ? process.env.TEST_RELEASES : url, options)`
  )
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function launch(extra: Record<string, string> = {}): Promise<Client> {
  const cache = mkdtempSync(path.join(dir, 'cache-'))
  const client = new Client({ name: 'acquisition-test', version: '1' })
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
    HOME: cache,
    XDG_CACHE_HOME: cache,
    LOCALAPPDATA: cache,
    NODE_OPTIONS: `--import=${preload}`,
    TEST_RELEASES: `${base}/releases`,
    ...extra
  }
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
