import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openReference } from '../reference.js'
import { cached, cacheDirectory, publish, removeIfPossible, states } from './cache.js'
import type { CacheState } from './cache.js'
import { selectRelease, transferAsset } from './release.js'

let received = 0
let total: number | undefined
let warningMajor: number | undefined
let warningReported = false

let outcome: ReturnType<typeof acquire> | undefined = acquire()

async function acquire(): Promise<{ path?: string; error?: unknown }> {
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
    if (warningMajor !== undefined && warningMajor !== 0) {
      console.error(`newer reference data needs wotlk-mcp@${warningMajor}; update your config`)
    }
    void (async (): Promise<void> => {
      try {
        await update(cacheDirectory(), snapshot.state)
      } catch (error) {
        console.error(
          `reference update check failed: ${String(error).replaceAll(/[\r\n]+/gu, ' ')}`
        )
      }
    })()
    return snapshot.path
  }

  try {
    const result = await download()

    if (result === undefined || result === '') {
      throw new Error('verified cache could not be opened')
    }

    return result
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
  } catch (error) {
    lock.close()
    throw error
  }

  try {
    try {
      const latest = (await states(directory))[0]?.state ?? current
      const now = Date.now()

      if (now - latest.lastCheck < 24 * 60 * 60 * 1000) {
        return
      }

      const attempted = { ...current, lastCheck: now }

      await publish(directory, attempted, now)

      let promoted: string | undefined

      try {
        promoted = await download(attempted)
      } finally {
        if (promoted === undefined || promoted === '') {
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

function setTotal(value: number): void {
  total = value
}

function addReceived(value: number): void {
  received += value
}

async function selectedSnapshot(directory: string): Promise<string> {
  const snapshot = await cached(directory)

  if (!snapshot) {
    throw new Error('verified cache could not be opened')
  }

  return snapshot.path
}

function downloadProgress(): string {
  let progress = ''
  if (received) {
    progress = ` (${received}`
    if (total !== undefined && total !== 0) {
      progress += ` of ${total}`
    }
    progress += ' bytes)'
  }
  return progress
}

function releaseAsset(selected: Awaited<ReturnType<typeof selectRelease>>): {
  readonly url: string
  readonly digest: string
} {
  const asset = selected.release.assets.find((item) => item.name === 'wotlk.sqlite.br')
  if (
    asset?.digest === undefined ||
    asset.digest === null ||
    asset.digest === '' ||
    !/^sha256:[0-9a-f]{64}$/iu.test(asset.digest)
  ) {
    throw new Error('release asset missing required SHA-256 digest')
  }
  return { digest: asset.digest, url: asset.url }
}

async function download(existing?: CacheState): Promise<string | undefined> {
  const selected = await selectRelease((value) => {
    warningMajor = value
  })

  if (existing && selected.release.tag_name === existing.version) {
    return undefined
  }

  const asset = releaseAsset(selected)

  const directory = cacheDirectory()

  await mkdir(directory, { recursive: true })

  const id = randomUUID()
  const compressed = path.join(directory, `${process.pid}-${id}.br.partial`)
  const partial = path.join(directory, `${process.pid}-${id}.sqlite.partial`)
  const final = path.join(directory, `${selected.release.tag_name}-${process.pid}-${id}.sqlite`)
  const statePartial = path.join(directory, `${process.pid}-${id}.json.partial`)

  try {
    await transferAsset(asset.url, asset.digest, compressed, partial, setTotal, addReceived)
    openReference(partial).close()
    await rename(partial, final)

    await publishDownloadState(
      directory,
      statePartial,
      final,
      id,
      selected.release.tag_name,
      existing
    )

    if (existing) {
      return final
    }

    return await selectedSnapshot(directory)
  } finally {
    await Promise.all([
      removeIfPossible(compressed),
      removeIfPossible(partial),
      removeIfPossible(statePartial)
    ])
  }
}

async function publishDownloadState(
  directory: string,
  partial: string,
  final: string,
  id: string,
  version: string,
  existing?: CacheState
): Promise<void> {
  const checked = Math.max(Date.now(), (existing?.lastCheck ?? 0) + 2)
  await writeFile(
    partial,
    JSON.stringify({
      file: path.basename(final),
      lastCheck: existing?.lastCheck ?? checked,
      version,
      warningMajor
    } satisfies CacheState),
    { flag: 'wx' }
  )
  await rename(partial, path.join(directory, `state-${checked}-${id}.json`))
}

export function takeUpdateWarning(): string | undefined {
  if (warningMajor === undefined || warningMajor === 0 || warningReported) {
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

    if (
      typeof result.error === 'number'
        ? result.error !== 0 && !Number.isNaN(result.error)
        : result.error !== undefined &&
          result.error !== null &&
          result.error !== false &&
          result.error !== 0n &&
          result.error !== ''
    ) {
      if (outcome === attempt) {
        outcome = undefined
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error))
    }

    if (result.path === undefined || result.path === '') {
      throw new Error('no reference database')
    }

    return result.path
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
