import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Docker = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

export function prepareWorldInputs(
  database: string,
  sourceDirectory: string,
  rejectCustomSql: (directory: string) => void
): void {
  if (!existsSync(database)) {
    throw new Error('Reference database does not exist')
  }

  for (const directory of ['data/sql/custom', 'modules']) {
    const location = path.join(sourceDirectory, directory)

    if (existsSync(location)) {
      rejectCustomSql(location)
    }
  }
}

export function installWorldSignalHandlers(abort: () => void): () => void {
  function onInterrupt(): void {
    process.exitCode = 130
    abort()
  }

  function onTerminate(): void {
    process.exitCode = 143
    abort()
  }

  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  return () => {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}

export async function cleanupWorldResources(
  importer: string,
  container: string,
  prefix: string,
  importerStarted: boolean,
  mysqlStarted: boolean,
  networkCreated: boolean,
  failed: boolean,
  run: (args: readonly string[]) => Promise<unknown>
): Promise<unknown> {
  const removals: string[][] = []
  let cleanupFailure: unknown

  if (importerStarted) {
    removals.push(['rm', '-fv', importer])
  }
  if (mysqlStarted) {
    removals.push(['rm', '-fv', container])
  }
  if (networkCreated) {
    removals.push(['network', 'rm', prefix])
  }

  for (const args of removals) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await run(args)
    } catch (error) {
      cleanupFailure ??= error
      if (failed) {
        console.error('World resource cleanup failed:', error)
      }
    }
  }

  return cleanupFailure
}

export function finishWorldImport(
  failed: boolean,
  failure: unknown,
  cleanupFailure: unknown,
  aborted: boolean
): void {
  if (failed) {
    throw failure
  }
  const hasCleanupFailure = Boolean(cleanupFailure)
  if (hasCleanupFailure) {
    throw cleanupFailure
  }
  if (aborted) {
    throw new Error('World import interrupted')
  }
}

export async function prepareWorldImporter(
  docker: Docker,
  container: string,
  prefix: string,
  mysqlImage: string,
  signal: Readonly<AbortSignal>
): Promise<void> {
  await docker([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    prefix,
    '--platform',
    'linux/amd64',
    '-e',
    'MYSQL_ROOT_PASSWORD=local-proof-only',
    mysqlImage,
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_general_ci',
    '--default-time-zone=+00:00',
    '--sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
  ])

  await waitForMysql(docker, container, signal)

  await docker([
    'exec',
    '-e',
    'MYSQL_PWD=local-proof-only',
    container,
    'mysql',
    '-uroot',
    '-e',
    "CREATE USER 'proof'@'%' IDENTIFIED BY 'local-proof-only'; GRANT ALL PRIVILEGES ON *.* TO 'proof'@'%';"
  ])
}

async function waitForMysql(
  docker: Docker,
  container: string,
  signal: Readonly<AbortSignal>
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await docker([
        'exec',
        '-e',
        'MYSQL_PWD=local-proof-only',
        container,
        'mysql',
        '-h127.0.0.1',
        '-uroot',
        '--batch',
        '--skip-column-names',
        '-e',
        'SELECT 1'
      ])
      return
    } catch (error) {
      if (signal.aborted) {
        throw error
      }

      // eslint-disable-next-line no-await-in-loop
      await delay(1000, undefined, { signal })
    }
  }

  throw new Error('MySQL did not become ready')
}

export async function runWorldImporter(
  docker: Docker,
  container: string,
  importer: string,
  prefix: string,
  importerImage: string,
  mount: string,
  log: string
): Promise<void> {
  try {
    const result = await docker([
      'run',
      '--name',
      importer,
      '--platform',
      'linux/amd64',
      '--network',
      prefix,
      '--mount',
      mount,
      '-e',
      'AC_DISABLE_INTERACTIVE=1',
      '-e',
      'AC_SOURCE_DIRECTORY=/source',
      '-e',
      'AC_UPDATES_ALLOWED_MODULES=',
      '-e',
      `AC_LOGIN_DATABASE_INFO=${container};3306;proof;local-proof-only;acore_auth`,
      '-e',
      `AC_WORLD_DATABASE_INFO=${container};3306;proof;local-proof-only;acore_world`,
      '-e',
      `AC_CHARACTER_DATABASE_INFO=${container};3306;proof;local-proof-only;acore_characters`,
      importerImage
    ])

    writeFileSync(log, result.stdout + result.stderr)
  } catch (error) {
    writeFileSync(log, importerOutput(error))
    throw error
  }
}

function importerOutput(error: unknown): string {
  let output = ''

  if (error !== null && typeof error === 'object') {
    if ('stdout' in error && typeof error.stdout === 'string') {
      output += error.stdout
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      output += error.stderr
    }
  }

  return output
}
