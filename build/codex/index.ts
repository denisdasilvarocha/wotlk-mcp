import { run } from '../shared/exec.ts'
import { installSignalHandlers } from '../shared/signals.ts'
import { hashCodex, type CodexSource } from '../sources/index.ts'
import { evaluateCodex } from './evaluation.ts'
import { importCodexRows } from './rows.ts'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type { DeepReadonly } from '../../src/acquire/release.ts'

export type CodexValue =
  | string
  | number
  | boolean
  | null
  | readonly CodexValue[]
  | { readonly [key: string]: CodexValue | undefined }

export interface CodexRow {
  readonly [key: string]: CodexValue | undefined
  readonly name: string
  readonly description?: string
  readonly category?: string
  readonly bookPage?: number
}

export type ReadonlyCodexSource = DeepReadonly<CodexSource>

export interface CodexData {
  readonly API_FUNCTIONS: readonly Readonly<CodexRow>[]
  readonly EVENTS: readonly Readonly<CodexRow>[]
  readonly WIDGETS: readonly (Readonly<CodexRow> & {
    readonly methods: readonly Readonly<CodexRow>[]
    readonly inheritedMethods: readonly Readonly<CodexRow>[]
  })[]
  readonly CVARS: readonly Readonly<CodexRow>[]
  readonly DATA_TYPES: readonly Readonly<CodexRow>[]
  readonly COMBAT_LOG_SUB_EVENTS: readonly (Readonly<CodexRow> & {
    readonly arguments: readonly CodexValue[]
    readonly prefixes?: readonly string[]
  })[]
  readonly COMBAT_LOG_PREFIXES: readonly (Readonly<CodexRow> & {
    readonly arguments: readonly CodexValue[]
  })[]
  readonly SECURE_TEMPLATES: readonly Readonly<CodexRow>[]
  readonly CHAPTER_PAGES: Readonly<Record<string, number>>
}

function verifyCodexSource(source: ReadonlyCodexSource): void {
  if (hashCodex(source.directory, source.files).sha256 !== source.sha256) {
    throw new Error('Codex aggregate SHA-256 mismatch')
  }
}

export async function readCodex(
  source: ReadonlyCodexSource,
  nodeImage: string
): Promise<CodexData> {
  verifyCodexSource(source)

  const container = `wotlk-codex-${randomBytes(12).toString('hex')}`
  const controller = new AbortController()
  const removeSignalHandlers = installSignalHandlers(controller.abort.bind(controller))

  let failed = false
  let failure: unknown
  let result: CodexData | undefined

  try {
    result = await evaluateCodex(source.directory, nodeImage, container, controller.signal)
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try {
      await run('docker', ['rm', '-fv', container], { killSignal: 'SIGKILL', timeout: 60_000 })
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    } finally {
      removeSignalHandlers()
    }
  }

  if (failed) {
    throw failure
  }
  if (controller.signal.aborted) {
    throw new Error('Codex evaluation interrupted')
  }
  if (!result) {
    throw new Error('Codex evaluation returned no data')
  }

  return result
}

export function importCodex(database: string, source: ReadonlyCodexSource, data: CodexData): void {
  const db = new DatabaseSync(database)

  db.exec('BEGIN')

  try {
    importCodexRows(db, source, data)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  } finally {
    db.close()
  }
}
