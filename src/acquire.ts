import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import * as z from 'zod'

import { openReference } from './reference.js'
import { acceptedSchemaMajor } from './schema.js'

const releasesUrl = 'https://api.github.com/repos/denisdasilvarocha/wotlk-mcp/releases?per_page=100'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const headers: Record<string, string> = {
  'User-Agent': 'wotlk-mcp',
  Accept: 'application/vnd.github+json'
}
if (token) headers.Authorization = `Bearer ${token}`
let received = 0
let total: number | undefined

function cacheDirectory(): string {
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
      'wotlk-mcp'
    )
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'wotlk-mcp')
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'wotlk-mcp')
}

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullish(),
    assets: z.array(
      z.object({ name: z.string(), digest: z.string().nullish(), browser_download_url: z.string() })
    )
  })
)

const cacheStateSchema = z.object({
  file: z.string().regex(/^db-v\d+\.\d+\.\d+-[0-9a-f-]+\.sqlite$/),
  version: z.string().regex(/^db-v\d+\.\d+\.\d+$/),
  lastCheck: z.number().nullable(),
  warningMajor: z.number().int().positive().optional()
})
type CacheState = z.infer<typeof cacheStateSchema>

async function states(directory: string): Promise<{ name: string; state: CacheState }[]> {
  const names = (await readdir(directory)).filter((name) =>
    /^state-\d+-[0-9a-f-]+\.json$/.test(name)
  )
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const state = cacheStateSchema.parse(
          JSON.parse(await readFile(path.join(directory, name), 'utf8'))
        )
        return { name, state }
      } catch {
        return undefined
      }
    })
  )
  return entries
    .filter((entry) => entry !== undefined)
    .toSorted((a, b) => b.name.localeCompare(a.name))
}

function errorCode(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error) return error.code
  return undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

async function removeIfPossible(file: string): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].some((code) => code === errorCode(error))) throw error
  }
}

async function cached(directory: string): Promise<{ path: string; state: CacheState } | undefined> {
  await mkdir(directory, { recursive: true })
  const entries = await states(directory)
  const keep = new Set<string>()
  const files = new Set<string>()
  let selected: { path: string; state: CacheState } | undefined
  async function select(index: number): Promise<void> {
    const entry = entries[index]
    if (!entry || files.size >= 2) return
    if (files.has(entry.state.file)) {
      await select(index + 1)
      return
    }
    const source = path.join(directory, entry.state.file)
    const session = path.join(directory, `session-${process.pid}-${randomUUID()}.sqlite`)
    try {
      await link(source, session)
      openReference(session).close()
      keep.add(entry.name)
      keep.add(entry.state.file)
      files.add(entry.state.file)
      if (!selected) {
        selected = { path: session, state: entry.state }
        process.once('exit', () => {
          try {
            unlinkSync(session)
          } catch {
            /* Windows may retain an open snapshot. */
          }
        })
      } else await removeIfPossible(session)
    } catch {
      await removeIfPossible(session)
    }
    await select(index + 1)
  }
  await select(0)
  const now = Date.now()
  await Promise.all(
    (await readdir(directory)).map(async (name) => {
      if (keep.has(name)) return
      const partial = /^(\d+)-[0-9a-f-]+\.(?:br|sqlite|json)\.partial$/.exec(name)
      const session = /^session-(\d+)-[0-9a-f-]+\.sqlite$/.exec(name)
      const promoting = /^db-v\d+\.\d+\.\d+-(\d+)-[0-9a-f-]+\.sqlite$/.exec(name)
      const old =
        /^state-\d+-[0-9a-f-]+\.json$/.test(name) ||
        /^db-v\d+\.\d+\.\d+-[0-9a-f-]+\.sqlite$/.test(name)
      if (!partial && !session && !old) return
      if ((partial || session) && processAlive(Number((partial ?? session)?.[1]))) return
      if (promoting && processAlive(Number(promoting[1]))) return
      const file = path.join(directory, name)
      try {
        // shortcut: retain recent orphans for a day; upgrade to coordinated cleanup if disk pressure demands it.
        if (now - (await stat(file)).mtimeMs > 24 * 60 * 60 * 1000) await removeIfPossible(file)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    })
  )
  return selected
}

async function download(existing?: CacheState): Promise<string | undefined> {
  const response = await fetch(releasesUrl, { headers })
  if (!response.ok) throw new Error(`GitHub releases request returned HTTP ${response.status}`)
  const releases = releasesSchema.parse(await response.json())
  const candidates = releases
    .flatMap((release) => {
      const match = /^db-v(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name)
      if (!match || release.draft || release.prerelease) return []
      return [{ release, version: match.slice(1).map(Number) }]
    })
    .toSorted((a, b) => (b.release.published_at ?? '').localeCompare(a.release.published_at ?? ''))
  const selected = candidates.find(({ version }) => version[0] === acceptedSchemaMajor)
  const higher = candidates.find(({ version }) => version[0] > acceptedSchemaMajor)
  if (existing) warningMajor = higher?.version[0]
  if (existing && higher)
    console.error(`newer reference data needs wotlk-mcp@${warningMajor}; update your config`)
  if (!selected) {
    if (higher)
      throw new Error(
        `no compatible release; newer reference data needs wotlk-mcp@${higher.version[0]}`
      )
    throw new Error('no compatible published reference release')
  }
  if (existing && selected.release.tag_name === existing.version) return undefined
  const asset = selected.release.assets.find((item) => item.name === 'wotlk.sqlite.br')
  if (!asset?.digest || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest))
    throw new Error('release asset missing required SHA-256 digest')
  const directory = cacheDirectory()
  await mkdir(directory, { recursive: true })
  const id = randomUUID()
  const compressed = path.join(directory, `${process.pid}-${id}.br.partial`)
  const partial = path.join(directory, `${process.pid}-${id}.sqlite.partial`)
  const final = path.join(directory, `${selected.release.tag_name}-${process.pid}-${id}.sqlite`)
  const statePartial = path.join(directory, `${process.pid}-${id}.json.partial`)
  try {
    const assetResponse = await fetch(asset.browser_download_url, { headers })
    if (!assetResponse.ok || !assetResponse.body)
      throw new Error(`database download returned HTTP ${assetResponse.status}`)
    const length = Number(assetResponse.headers.get('content-length'))
    if (Number.isSafeInteger(length) && length > 0) total = length
    const hash = createHash('sha256')
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        received += chunk.length
        hash.update(chunk)
        callback(undefined, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(assetResponse.body),
      progress,
      createWriteStream(compressed, { flags: 'wx' })
    )
    if (`sha256:${hash.digest('hex')}` !== asset.digest.toLowerCase())
      throw new Error('database SHA-256 digest mismatch')
    await pipeline(
      createReadStream(compressed),
      createBrotliDecompress(),
      createWriteStream(partial, { flags: 'wx' })
    )
    openReference(partial).close()
    await rename(partial, final)
    const checked = Math.max(Date.now(), (existing?.lastCheck ?? 0) + 2)
    await writeFile(
      statePartial,
      JSON.stringify({
        file: path.basename(final),
        version: selected.release.tag_name,
        lastCheck: existing?.lastCheck ?? checked,
        warningMajor
      } satisfies CacheState),
      { flag: 'wx' }
    )
    await rename(statePartial, path.join(directory, `state-${checked}-${id}.json`))
    if (existing) return final
    const snapshot = await cached(directory)
    if (!snapshot) throw new Error('verified cache could not be opened')
    return snapshot.path
  } finally {
    await Promise.all([
      removeIfPossible(compressed),
      removeIfPossible(partial),
      removeIfPossible(statePartial)
    ])
  }
}

let warningMajor: number | undefined
let warningReported = false

export function takeUpdateWarning(): string | undefined {
  if (!warningMajor || warningReported) return undefined
  warningReported = true
  return `note: newer reference data needs wotlk-mcp@${warningMajor}; update your config`
}

async function update(directory: string, current: CacheState): Promise<void> {
  const lock = new DatabaseSync(path.join(directory, 'update-lock.sqlite'), { timeout: 0 })
  try {
    lock.exec('BEGIN IMMEDIATE')
  } catch (error) {
    lock.close()
    throw error
  }
  try {
    try {
      const latest = (await states(directory))[0]?.state ?? current
      const now = Date.now()
      if (latest.lastCheck !== null && now - latest.lastCheck < 24 * 60 * 60 * 1000) return
      const attempted = { ...current, lastCheck: now }
      async function publish(state: CacheState, timestamp: number): Promise<void> {
        const id = randomUUID()
        const partial = path.join(directory, `${process.pid}-${id}.json.partial`)
        await writeFile(partial, JSON.stringify(state), { flag: 'wx' })
        await rename(partial, path.join(directory, `state-${timestamp}-${id}.json`))
      }
      await publish(attempted, now)
      let promoted: string | undefined
      try {
        promoted = await download(attempted)
      } finally {
        if (!promoted) await publish({ ...attempted, warningMajor }, Math.max(Date.now(), now + 1))
      }
    } finally {
      lock.exec('ROLLBACK')
    }
  } finally {
    lock.close()
  }
}

const selected: Promise<string> = (async () => {
  const override = process.env.WOTLK_MCP_DB
  if (override !== undefined)
    try {
      const resolved = path.resolve(override)
      openReference(resolved).close()
      return resolved
    } catch (error) {
      throw new Error(
        `invalid WOTLK_MCP_DB: ${String(error).replace(/[\r\n]+/g, ' ')}; select a compatible reference database`,
        { cause: error }
      )
    }
  const snapshot = await cached(cacheDirectory())
  if (snapshot) {
    ;({ warningMajor } = snapshot.state)
    if (warningMajor)
      console.error(`newer reference data needs wotlk-mcp@${warningMajor}; update your config`)
    void (async (): Promise<void> => {
      try {
        await update(cacheDirectory(), snapshot.state)
      } catch (error) {
        console.error(`reference update check failed: ${String(error).replace(/[\r\n]+/g, ' ')}`)
      }
    })()
    return snapshot.path
  }
  try {
    const result = await download()
    if (!result) throw new Error('verified cache could not be opened')
    return result
  } catch (error) {
    throw new Error(
      `no reference database: download failed (${String(error).replace(/[\r\n]+/g, ' ')}); retry online or set WOTLK_MCP_DB`,
      { cause: error }
    )
  }
})()
const outcome = (async (): Promise<{ path?: string; error?: unknown }> => {
  try {
    return { path: await selected }
  } catch (error) {
    return { error }
  }
})()

export async function getReferencePath(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      outcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          let progress = ''
          if (received) {
            progress = ` (${received}`
            if (total) progress += ` of ${total}`
            progress += ' bytes)'
          }
          reject(new Error(`reference database downloading${progress}; retry shortly`))
        }, 20_000)
      })
    ])
    if (result.error) throw result.error
    if (!result.path) throw new Error('no reference database')
    return result.path
  } finally {
    if (timer) clearTimeout(timer)
  }
}
