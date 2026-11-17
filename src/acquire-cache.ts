import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import * as z from 'zod'

import { openReference } from './reference.js'
import { acceptedSchemaMajor } from './schema.js'
const cacheStateSchema = z.object({
  file: z.string().regex(/^db-v\d+\.\d+\.\d+-[0-9a-f-]+\.sqlite$/u),
  lastCheck: z.number(),
  version: z.string().regex(/^db-v\d+\.\d+\.\d+$/u),
  warningMajor: z.number().int().positive().optional()
})
export type CacheState = z.infer<typeof cacheStateSchema>
type CacheEntry = { name: string; state: CacheState }
async function linkSnapshot(source: string, session: string): Promise<void> {
  await link(source, session)
  openReference(session).close()
}
async function cacheNames(directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  return readdir(directory)
}

export async function cached(
  directory: string
): Promise<{ path: string; state: CacheState } | undefined> {
  const names = await cacheNames(directory)
  const entries = await states(directory)
  const keep = new Set<string>()
  const files = new Set<string>()
  let selected: { path: string; state: CacheState } | undefined

  async function select(index: number): Promise<void> {
    const entry = entries[index]

    if (entry === undefined || files.size >= 2) {
      return
    }

    if (files.has(entry.state.file)) {
      await select(index + 1)
      return
    }

    const source = path.join(directory, entry.state.file)
    const session = path.join(directory, `session-${process.pid}-${randomUUID()}.sqlite`)

    try {
      await linkSnapshot(source, session)
      keep.add(entry.name)
      keep.add(entry.state.file)
      files.add(entry.state.file)

      if (selected) {
        await removeIfPossible(session)
      } else {
        selected = { path: session, state: entry.state }
        removeSessionOnExit(session)
      }
    } catch {
      await removeIfPossible(session)
    }

    await select(index + 1)
  }

  await select(0)

  await cleanup(directory, names, [...keep])

  return selected
}

function removeSessionOnExit(session: string): void {
  process.once('exit', () => {
    try {
      unlinkSync(session)
    } catch {
      /* Windows may retain an open snapshot. */
    }
  })
}

async function cleanup(
  directory: string,
  names: readonly string[],
  keep: readonly string[]
): Promise<void> {
  const now = Date.now()
  await Promise.all(
    names.map(async (name) => {
      if (keep.includes(name)) {
        return
      }

      const partial = /^(\d+)-[0-9a-f-]+\.(?:br|sqlite|json)\.partial$/u.exec(name)
      const session = /^session-(\d+)-[0-9a-f-]+\.sqlite$/u.exec(name)
      const promoting = /^db-v\d+\.\d+\.\d+-(\d+)-[0-9a-f-]+\.sqlite$/u.exec(name)
      const old =
        /^state-\d+-[0-9a-f-]+\.json$/u.test(name) ||
        /^db-v\d+\.\d+\.\d+-[0-9a-f-]+\.sqlite$/u.test(name)

      if (!partial && !session && !old) {
        return
      }
      if ((partial || session) && processAlive(Number((partial ?? session)?.[1]))) {
        return
      }
      if (promoting && processAlive(Number(promoting[1]))) {
        return
      }

      const file = path.join(directory, name)

      try {
        // shortcut: retain recent orphans for a day; upgrade to coordinated cleanup if disk pressure demands it.
        if (now - (await stat(file)).mtimeMs > 24 * 60 * 60 * 1000) {
          await removeIfPossible(file)
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error
        }
      }
    })
  )
}

export async function states(directory: string): Promise<{ name: string; state: CacheState }[]> {
  const names = (await readdir(directory)).filter((name) =>
    /^state-\d+-[0-9a-f-]+\.json$/u.test(name)
  )
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const state = cacheStateSchema.parse(
          JSON.parse(await readFile(path.join(directory, name), 'utf8'))
        )

        return { name, state }
      } catch {
        return null
      }
    })
  )

  return entries
    .filter((entry: Readonly<CacheEntry> | null) => entry !== null)
    .toSorted((a: Readonly<CacheEntry>, b: Readonly<CacheEntry>) => b.name.localeCompare(a.name))
}

export async function removeIfPossible(file: string): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].some((code) => code === errorCode(error))) {
      throw error
    }
  }
}

function errorCode(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code
  }

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

export function cacheDirectory(): string {
  let root = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')

  if (process.platform === 'win32') {
    root = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
  }
  if (process.platform === 'darwin') {
    root = path.join(homedir(), 'Library', 'Caches')
  }

  // Per schema major, so side-by-side package majors never prune each other's copies.
  return path.join(root, 'wotlk-mcp', `schema-${acceptedSchemaMajor}`)
}
export async function publish(
  directory: string,
  state: CacheState,
  timestamp: number
): Promise<void> {
  const id = randomUUID()
  const partial = path.join(directory, `${process.pid}-${id}.json.partial`)
  await writeFile(partial, JSON.stringify(state), { flag: 'wx' })
  await rename(partial, path.join(directory, `state-${timestamp}-${id}.json`))
}
