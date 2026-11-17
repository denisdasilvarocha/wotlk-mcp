import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { run } from './exec.ts'
import type { SourceArchive } from './sources.ts'
import { exportWorld } from './world-export.ts'
import {
  cleanupWorldResources,
  finishWorldImport,
  installWorldSignalHandlers,
  prepareWorldImporter,
  prepareWorldInputs,
  runWorldImporter
} from './world-import-containers.ts'

const mysqlImage = 'mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565'

function rejectCustomSql(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      rejectCustomSql(file)
    } else if (entry.name.endsWith('.sql')) {
      throw new Error(`custom or module SQL is not allowed: ${file}`)
    }
  }
}

async function runDocker(
  args: readonly string[],
  signal: Readonly<AbortSignal>
): Promise<{ stdout: string; stderr: string }> {
  const command = run('docker', args, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    signal
  })

  function abort(): void {
    command.child.kill('SIGKILL')
  }

  signal.addEventListener('abort', abort)

  if (signal.aborted) {
    abort()
  }

  try {
    return await command
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
async function exportImportedWorld(
  container: string,
  database: string,
  source: Readonly<SourceArchive>,
  importerImage: string,
  work: string,
  signal: Readonly<AbortSignal>
): Promise<void> {
  await exportWorld(container, database, source, importerImage, work, signal, mysqlImage, runDocker)
}

function cleanupDocker(args: readonly string[]): Promise<unknown> {
  return run('docker', [...args], { killSignal: 'SIGKILL', timeout: 60_000 })
}

export async function importWorld(
  database: string,
  source: Readonly<SourceArchive>,
  importerImage: string,
  work: string
): Promise<void> {
  prepareWorldInputs(database, source.directory, rejectCustomSql)
  mkdirSync(work)
  const prefix = `wotlk-world-${randomBytes(12).toString('hex')}`
  const container = `${prefix}-mysql`
  const controller = new AbortController()
  const importer = `${prefix}-importer`
  const removeSignalHandlers = installWorldSignalHandlers((): void => {
    controller.abort()
  })
  let cleanupFailure: unknown
  let failed = false
  let failure: unknown
  let importerStarted = false
  let mysqlStarted = false
  let networkCreated = false
  function docker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return runDocker([...args], controller.signal)
  }
  try {
    networkCreated = true
    await docker(['network', 'create', prefix])
    mysqlStarted = true
    await prepareWorldImporter(docker, container, prefix, mysqlImage, controller.signal)
    const mount = `type=bind,"src=${path.resolve(source.directory).replaceAll('"', '""')}",dst=/source,readonly`
    const log = path.join(work, 'updater.log')

    importerStarted = true
    await runWorldImporter(docker, container, importer, prefix, importerImage, mount, log)

    await exportImportedWorld(container, database, source, importerImage, work, controller.signal)
  } catch (error) {
    failed = true
    failure = error
  } finally {
    const resources = [importer, container, prefix] as const
    const started = [importerStarted, mysqlStarted, networkCreated] as const
    cleanupFailure = await cleanupWorldResources(...resources, ...started, failed, cleanupDocker)
    removeSignalHandlers()
  }

  finishWorldImport(failed, failure, cleanupFailure, controller.signal.aborted)
}
