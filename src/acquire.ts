import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import * as z from 'zod'

import { openReference } from './reference.js'
import { acceptedSchemaMajor } from './schema.js'
export { acceptedSchemaMajor } from './schema.js'

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
    assets: z.array(
      z.object({ name: z.string(), digest: z.string().nullish(), browser_download_url: z.string() })
    )
  })
)

async function download(): Promise<string> {
  const response = await fetch(releasesUrl, { headers })
  if (!response.ok) throw new Error(`GitHub releases request returned HTTP ${response.status}`)
  const releases = releasesSchema.parse(await response.json())
  const candidates = releases
    .flatMap((release) => {
      const match = /^db-v(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name)
      if (!match || release.draft || release.prerelease) return []
      return [{ release, version: match.slice(1).map(Number) }]
    })
    .toSorted(
      (a, b) =>
        b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]
    )
  const selected = candidates.find(({ version }) => version[0] === acceptedSchemaMajor)
  if (!selected) {
    const higher = candidates.find(({ version }) => version[0] > acceptedSchemaMajor)
    if (higher)
      throw new Error(
        `no compatible release; newer reference data needs wotlk-mcp@${higher.version[0]}`
      )
    throw new Error('no compatible published reference release')
  }
  const asset = selected.release.assets.find((item) => item.name === 'wotlk.sqlite.br')
  if (!asset?.digest || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest))
    throw new Error('release asset missing required SHA-256 digest')
  const directory = cacheDirectory()
  await mkdir(directory, { recursive: true })
  const id = randomUUID()
  const compressed = path.join(directory, `${id}.br.partial`)
  const partial = path.join(directory, `${id}.sqlite.partial`)
  const final = path.join(directory, `${selected.release.tag_name}-${id}.sqlite`)
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
    return final
  } finally {
    await Promise.all([rm(compressed, { force: true }), rm(partial, { force: true })])
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
  try {
    return await download()
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
