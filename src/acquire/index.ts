import { openReference } from '../reference.js'
import { cached, cacheDirectory, publish, removeIfPossible, states } from './cache.js'
import { selectRelease, transferAsset } from './release.js'
import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CacheState } from './cache.js'

let received = 0
let total: number | undefined
let warningMajor: number | undefined
let warningReported = false

let outcome: ReturnType<typeof acquire> | undefined = acquire()

async function acquire(): Promise<{ path: string } | { error: unknown }> {
  try {
    return { path: await selectReference() }
  } catch (error) {
    return { error }
  }
}

async function selectReference(): Promise<string> {
  received = 0
  total = undefined

  const override = process.env.WOTLK_MCP_DB

  if (override !== undefined) {
    return validateOverride(override)
  }

  const snapshot = await cached(cacheDirectory())

  if (snapshot) {
    ;({ warningMajor } = snapshot.state)
    if (warningMajor) {
      console.error(`newer reference data needs wotlk-mcp@${warningMajor}; update your config`)
    }
    void update(cacheDirectory(), snapshot.state).catch((error: unknown) => {
      console.error(`reference update check failed: ${String(error).replaceAll(/[\r\n]+/gu, ' ')}`)
    })
    return snapshot.path
  }

  try {
    await download()

    const downloaded = await cached(cacheDirectory())

    if (!downloaded) {
      throw new Error('verified cache could not be opened')
    }

    return downloaded.path
  } catch (error) {
    throw new Error(
      `no reference database: download failed (${String(error).replaceAll(/[\r\n]+/gu, ' ')}); retry online or set WOTLK_MCP_DB`,
      { cause: error }
    )
  }
}

function validateOverride(override: string): string {
  try {
    const resolved = path.resolve(override)
    openReference(resolved).close()
    return resolved
  } catch (error) {
    throw new Error(
      `invalid WOTLK_MCP_DB: ${String(error).replaceAll(/[\r\n]+/gu, ' ')}; select a compatible reference database`,
      { cause: error }
    )
  }
}

async function update(directory: string, current: CacheState): Promise<void> {
  const lock = new DatabaseSync(path.join(directory, 'update-lock.sqlite'), { timeout: 0 })

  try {
    lock.exec('BEGIN IMMEDIATE')

    try {
      const latest = (await states(directory))[0]?.state ?? current
      const now = Date.now()

      if (now - latest.lastCheck < 24 * 60 * 60 * 1000) {
        return
      }

      const attempted = { ...current, lastCheck: now }

      await publish(directory, attempted, now)

      let promoted = false

      try {
        promoted = await download(attempted)
      } finally {
        if (!promoted) {
          await publish(directory, { ...attempted, warningMajor }, Math.max(Date.now(), now + 1))
        }
      }
    } finally {
      lock.exec('ROLLBACK')
    }
  } finally {
    lock.close()
  }
}

function downloadProgress(): string {
  return received ? ` (${received}${total ? ` of ${total}` : ''} bytes)` : ''
}

async function download(existing?: CacheState): Promise<boolean> {
  const release = await selectRelease((value) => {
    warningMajor = value
  })

  if (release.tag_name === existing?.version) {
    return false
  }

  const asset = release.assets.find((item) => item.name === 'wotlk.sqlite.br')

  if (!asset?.digest || !/^sha256:[0-9a-f]{64}$/iu.test(asset.digest)) {
    throw new Error('release asset missing required SHA-256 digest')
  }

  const directory = cacheDirectory()

  await mkdir(directory, { recursive: true })

  const id = randomUUID()
  const compressed = path.join(directory, `${process.pid}-${id}.br.partial`)
  const partial = path.join(directory, `${process.pid}-${id}.sqlite.partial`)
  const final = path.join(directory, `${release.tag_name}-${process.pid}-${id}.sqlite`)

  try {
    await transferAsset(
      asset.url,
      asset.digest,
      compressed,
      partial,
      (value) => {
        total = value
      },
      (value) => {
        received += value
      }
    )
    openReference(partial).close()
    await rename(partial, final)

    const checked = Math.max(Date.now(), (existing?.lastCheck ?? 0) + 2)

    await publish(
      directory,
      {
        file: path.basename(final),
        lastCheck: existing?.lastCheck ?? checked,
        version: release.tag_name,
        warningMajor
      },
      checked
    )

    return true
  } finally {
    await Promise.all([removeIfPossible(compressed), removeIfPossible(partial)])
  }
}

export function takeUpdateWarning(): string | undefined {
  if (!warningMajor || warningReported) {
    return undefined
  }

  warningReported = true

  return `note: newer reference data needs wotlk-mcp@${warningMajor}; update your config`
}

export async function getReferencePath(): Promise<string> {
  const attempt = (outcome ??= acquire())
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const result = await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`reference database downloading${downloadProgress()}; retry shortly`))
        }, 20_000)
      })
    ])

    if ('error' in result) {
      if (outcome === attempt) {
        outcome = undefined
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error))
    }

    return result.path
  } finally {
    clearTimeout(timer)
  }
}
