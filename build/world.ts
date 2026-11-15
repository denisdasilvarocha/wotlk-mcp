import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { SourceArchive } from './sources.ts'

const mysqlImage = 'mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565'
const run = promisify(execFile)

function rejectCustomSql(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)

    if (entry.isDirectory()) rejectCustomSql(file)
    else if (entry.name.endsWith('.sql'))
      throw new Error(`custom or module SQL is not allowed: ${file}`)
  }
}

async function exportWorld(
  container: string,
  output: string,
  source: SourceArchive,
  importerImage: string,
  work: string,
  signal: AbortSignal
): Promise<void> {
  if (!existsSync(output)) throw new Error('Reference database does not exist')

  const mysqlArgs = [
    'exec',
    '-e',
    'MYSQL_PWD=local-proof-only',
    container,
    'mysql',
    '-uroot',
    '--default-character-set=utf8mb4',
    '--batch',
    '--raw',
    '--skip-column-names',
    '--quick',
    'acore_world',
    '-e'
  ]

  async function mysql(query: string): Promise<string> {
    const result = await runDocker([...mysqlArgs, query], signal)

    return result.stdout
  }

  const environment = await mysql(
    'SELECT VERSION(),@@global.sql_mode,@@global.time_zone,@@global.character_set_server,@@global.collation_server'
  )
  const expectedEnvironment =
    '8.4.3\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\t+00:00\tutf8mb4\tutf8mb4_general_ci\n'

  if (environment !== expectedEnvironment)
    throw new Error('World MySQL environment does not match the pinned reproduction')

  for (const part of ['columns', 'indexes']) {
    const expected = readFileSync(`data/world/schema-${part}.tsv`, 'utf8')
    // eslint-disable-next-line no-await-in-loop
    const actual = await mysql(readFileSync(`data/world/${part}.sql`, 'utf8'))

    writeFileSync(path.join(work, `schema-${part}.tsv`), actual)

    if (actual !== expected) throw new Error(`World schema ${part} drifted`)
  }

  type Kind = 'integer' | 'unsigned' | 'real' | 'text' | 'blob'
  interface Column {
    name: string
    type: string
    kind: Kind
  }

  const tables = new Map<string, Column[]>()

  for (const line of readFileSync('data/world/schema-columns.tsv', 'utf8').trimEnd().split('\n')) {
    let kind: Kind
    const [table, , name, type, , , , charset] = line.split('\t')

    if (/^(tinyint|smallint|mediumint|int|bigint)\b/.test(type)) {
      kind = 'integer'

      if (/^bigint.*unsigned/.test(type)) kind = 'unsigned'
    } else if (/^(float|double|real)\b/.test(type)) kind = 'real'
    else if (
      /^(decimal|numeric|date|datetime|timestamp|time|year|char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/.test(
        type
      )
    )
      kind = 'text'
    else if (/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/.test(type)) kind = 'blob'
    else throw new Error(`Unsupported MySQL type ${type} in ${table}.${name}`)

    if (charset && charset !== 'utf8mb4')
      throw new Error(`Unsupported character set ${charset} in ${table}.${name}`)

    const columns = tables.get(table) ?? []

    columns.push({ name, type, kind })
    tables.set(table, columns)
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })

  type Value = null | bigint | number | string | Uint8Array

  const sqlNull: unknown = JSON.parse('null')

  function decode(field: string, column: Column, table: string): Value {
    const { kind } = column

    if (field === 'N') {
      if (sqlNull !== null) throw new Error('Invalid SQL null')

      return sqlNull
    }

    if (!/^V(?:[0-9A-F]{2})*$/.test(field)) throw new Error('Invalid MySQL export field')

    const bytes = Buffer.from(field.slice(1), 'hex')

    if (kind === 'blob') return bytes

    const text = decoder.decode(bytes)

    if (kind === 'integer') {
      if (!/^-?\d+$/.test(text)) throw new Error(`Invalid integer ${text}`)

      const value = BigInt(text)

      if (value < -(1n << 63n) || value >= 1n << 63n)
        throw new Error(`Integer out of SQLite range: ${text}`)

      return value
    }

    if (kind === 'unsigned') {
      if (!/^\d+$/.test(text) || BigInt(text) >= 1n << 64n)
        throw new Error(`Invalid unsigned integer ${text}`)

      return BigInt(text).toString()
    }

    if (kind === 'real') {
      const value = Number(text)

      if (!text || !Number.isFinite(value) || Object.is(value, -0))
        throw new Error(`World floating conversion loss in ${table}.${column.name}: ${text}`)

      return value
    }

    return text
  }

  function hashRow(hash: Hash, columns: Column[], values: Value[]): void {
    if (values.length !== columns.length) throw new Error('Wrong number of exported fields')

    for (let i = 0; i < columns.length; i++) {
      const { kind } = columns[i]
      const value = values[i]

      if (
        value !== null &&
        ((kind === 'integer' && typeof value !== 'bigint') ||
          (kind === 'real' && typeof value !== 'number') ||
          ((kind === 'unsigned' || kind === 'text') && typeof value !== 'string') ||
          (kind === 'blob' && !(value instanceof Uint8Array)))
      )
        throw new Error(`Invalid SQLite storage type for ${columns[i].name}`)

      let bytes: Buffer
      let valueKind: string = kind

      if (value === null) {
        bytes = Buffer.alloc(0)
        valueKind = 'null'
      } else if (value instanceof Uint8Array) bytes = Buffer.from(value)
      else bytes = Buffer.from(String(value), 'utf8')

      hash.update(`${columns[i].type}:${valueKind}:${bytes.length}:`).update(bytes)
    }

    hash.update('\n')
  }

  async function scan(
    query: string,
    table: string,
    columns: Column[],
    consume: (values: Value[]) => void
  ): Promise<void> {
    const child = spawn('docker', [...mysqlArgs, query], {
      signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`MySQL export failed (${code}): ${stderr}`))
      })
    })

    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const fields = line.split('\t')

        if (fields.length !== columns.length) throw new Error('Wrong number of MySQL columns')

        consume(fields.map((field, i) => decode(field, columns[i], table)))
      }

      await exited
    } catch (error) {
      child.kill('SIGKILL')
      await exited.catch(() => {})
      throw error
    }
  }

  const db = new DatabaseSync(output)

  db.exec('BEGIN IMMEDIATE')

  try {
    const metadata = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )

    async function exportTable(table: string, columns: Column[]): Promise<void> {
      const destination = `world_${table}`
      const expressions = columns.map(({ name, kind }) => {
        const col = quoteMy(name)
        let value = col

        if (kind === 'real') value = `CAST(${col} AS DOUBLE)`

        return `IF(${col} IS NULL,'N',CONCAT('V',HEX(CAST(${value} AS BINARY))))`
      })
      const encoded = expressions.join(',')
      const query = `SELECT ${encoded} FROM ${quoteMy(table)} ORDER BY SHA2(CONCAT_WS(':',${encoded}),256),${expressions.map((e) => `BINARY ${e}`).join(',')}`
      const countText = (await mysql(`SELECT COUNT(*) FROM ${quoteMy(table)}`)).trim()

      if (!/^\d+$/.test(countText)) throw new Error(`Invalid source count for ${table}`)

      const expectedCount = BigInt(countText)
      let sourceCount = 0n
      const sourceHash = createHash('sha256')

      await scan(query, table, columns, (values) => {
        hashRow(sourceHash, columns, values)
        sourceCount++
      })

      db.exec(
        `CREATE TABLE ${quoteSqlite(destination)} (${columns
          .map(({ name, kind }) => {
            let type = 'TEXT'

            if (kind === 'integer') type = 'INTEGER'
            else if (kind === 'real') type = 'REAL'
            else if (kind === 'blob') type = 'BLOB'

            return `${quoteSqlite(name)} ${type}`
          })
          .join(', ')})`
      )

      let exportCount = 0n
      const insert = db.prepare(
        `INSERT INTO ${quoteSqlite(destination)} (${columns.map(({ name }) => quoteSqlite(name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      const exportHash = createHash('sha256')

      await scan(query, table, columns, (values) => {
        hashRow(exportHash, columns, values)
        insert.run(...values)
        exportCount++
      })

      const select = db.prepare(
        `SELECT ${columns.map(({ name }) => quoteSqlite(name)).join(',')} FROM ${quoteSqlite(destination)} ORDER BY rowid`
      )

      select.setReadBigInts(true)

      let sqliteCount = 0n
      const sqliteHash = createHash('sha256')

      for (const row of select.iterate()) {
        hashRow(
          sqliteHash,
          columns,
          columns.map(({ name }) => row[name])
        )
        sqliteCount++
      }

      const sourceDigest = sourceHash.digest('hex')

      if (
        sourceCount !== expectedCount ||
        exportCount !== expectedCount ||
        sqliteCount !== expectedCount ||
        exportHash.digest('hex') !== sourceDigest ||
        sqliteHash.digest('hex') !== sourceDigest
      )
        throw new Error(`World data count or logical hash mismatch in ${table}`)

      metadata.run(`hash.${destination}`, sourceDigest)
      metadata.run(`count.${destination}`, countText)
    }

    for (const [table, columns] of tables)
      // eslint-disable-next-line no-await-in-loop
      await exportTable(table, columns)

    const pins = db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()

    if (!pins || typeof pins.value !== 'string') throw new Error('Reference input pins are missing')

    metadata.run(
      'input_pins',
      JSON.stringify({ ...JSON.parse(pins.value), world: source.revision })
    )
    metadata.run('world.mysql_image', mysqlImage)
    metadata.run('world.importer_image', importerImage)
    db.prepare(
      'INSERT INTO source (name, pin, sha256, licence, attribution) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'world',
      source.revision,
      source.sha256,
      'GPL-2.0-or-later; data may have additional rights; see data/world/azerothcore-LICENSE.txt',
      `AzerothCore authors; see data/world/azerothcore-AUTHORS.txt. Modified by conversion to SQLite. Corresponding source: https://github.com/azerothcore/azerothcore-wotlk/tree/${source.revision}`
    )
    db.exec(`
    INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint)
    SELECT 'creature:' || entry, 'creature', name, 'world_creature_template', rowid,
      COALESCE(subname, ''),
      'level ' || minlevel || CASE WHEN maxlevel != minlevel THEN '-' || maxlevel ELSE '' END ||
        CASE WHEN COALESCE(subname, '') != '' THEN ', ' || subname ELSE '' END
    FROM world_creature_template;

    INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint)
    SELECT 'item:' || entry, 'item', name, 'world_item_template', rowid,
      COALESCE(description, ''), 'level ' || ItemLevel || ', quality ' || Quality
    FROM world_item_template;

    INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint)
    SELECT 'quest:' || ID, 'quest', COALESCE(LogTitle, ''), 'world_quest_template', rowid,
      COALESCE(LogDescription, ''), 'level ' || QuestLevel || ', zone ' || QuestSortID
    FROM world_quest_template;

    INSERT INTO record (id, kind, name, source_table, source_row, search_text, hint)
    SELECT 'gameobject:' || entry, 'gameobject', name, 'world_gameobject_template', rowid,
      COALESCE(castBarCaption, ''), ''
    FROM world_gameobject_template;

    INSERT INTO record_fts (id, name, text)
    SELECT id, name, search_text FROM record
    WHERE kind IN ('creature', 'item', 'quest', 'gameobject');
  `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

async function runDocker(
  args: string[],
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const command = run('docker', args, {
    encoding: 'utf8',
    signal,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024
  })

  function abort(): void {
    command.child.kill('SIGKILL')
  }

  signal.addEventListener('abort', abort)

  if (signal.aborted) abort()

  try {
    return await command
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function quoteMy(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

function quoteSqlite(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export async function importWorld(
  database: string,
  source: SourceArchive,
  importerImage: string,
  work: string
): Promise<void> {
  if (!existsSync(database)) throw new Error('Reference database does not exist')

  for (const directory of ['data/sql/custom', 'modules']) {
    const location = path.join(source.directory, directory)

    if (existsSync(location)) rejectCustomSql(location)
  }

  mkdirSync(work)

  const prefix = `wotlk-world-${randomBytes(12).toString('hex')}`
  const container = `${prefix}-mysql`
  const controller = new AbortController()
  const importer = `${prefix}-importer`

  function onInterrupt(): void {
    process.exitCode = 130
    controller.abort()
  }

  function onTerminate(): void {
    process.exitCode = 143
    controller.abort()
  }

  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  let cleanupFailure: unknown
  let failed = false
  let failure: unknown
  let importerStarted = false
  let mysqlStarted = false
  let networkCreated = false

  function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runDocker(args, controller.signal)
  }

  try {
    networkCreated = true
    await docker(['network', 'create', prefix])
    mysqlStarted = true
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

    let ready = false

    for (let attempt = 0; attempt < 120; attempt++)
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
        ready = true
        break
      } catch (error) {
        if (controller.signal.aborted) throw error

        // eslint-disable-next-line no-await-in-loop
        await delay(1000, undefined, { signal: controller.signal })
      }

    if (!ready) throw new Error('MySQL did not become ready')

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

    const mount = `type=bind,"src=${path.resolve(source.directory).replaceAll('"', '""')}",dst=/source,readonly`
    const log = path.join(work, 'updater.log')

    importerStarted = true

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
      let output = ''

      if (error && typeof error === 'object') {
        if ('stdout' in error && typeof error.stdout === 'string') output += error.stdout

        if ('stderr' in error && typeof error.stderr === 'string') output += error.stderr
      }

      writeFileSync(log, output)
      throw error
    }

    await exportWorld(container, database, source, importerImage, work, controller.signal)
  } catch (error) {
    failed = true
    failure = error
  } finally {
    const removals: string[][] = []

    if (importerStarted) removals.push(['rm', '-fv', importer])

    if (mysqlStarted) removals.push(['rm', '-fv', container])

    if (networkCreated) removals.push(['network', 'rm', prefix])

    for (const args of removals)
      try {
        // eslint-disable-next-line no-await-in-loop
        await run('docker', args, { timeout: 60_000, killSignal: 'SIGKILL' })
      } catch (error) {
        cleanupFailure ??= error

        if (failed) console.error('World resource cleanup failed:', error)
      }

    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }

  if (failed) throw failure
  if (cleanupFailure) throw cleanupFailure
  if (controller.signal.aborted) throw new Error('World import interrupted')
}
