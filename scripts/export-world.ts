import { execFileSync, spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

const [, , container, output, ...extra] = process.argv
// The container must be the unmodified output of world/reproduce.sh; schema checks alone cannot authenticate its data.
if (!container || !output || extra.length)
  throw new Error('Usage: vpx scripts/export-world.ts <mysql-container> <reference.sqlite>')
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
function mysql(query: string): string {
  return execFileSync('docker', [...mysqlArgs, query], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
}
function quoteMy(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}
function quoteSqlite(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

const environment = mysql(
  'SELECT VERSION(),@@global.sql_mode,@@global.time_zone,@@global.character_set_server,@@global.collation_server'
)
const expectedEnvironment =
  '8.4.3\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\t+00:00\tutf8mb4\tutf8mb4_general_ci\n'
if (environment !== expectedEnvironment)
  throw new Error('World MySQL environment does not match the pinned reproduction')

for (const part of ['columns', 'indexes']) {
  const expected = readFileSync(`world/schema-${part}.tsv`, 'utf8')
  const actual = mysql(readFileSync(`world/${part}.sql`, 'utf8'))
  if (actual !== expected) throw new Error(`World schema ${part} drifted`)
}

type Kind = 'integer' | 'unsigned' | 'real' | 'text' | 'blob'
interface Column {
  name: string
  type: string
  kind: Kind
}
const tables = new Map<string, Column[]>()
for (const line of readFileSync('world/schema-columns.tsv', 'utf8').trimEnd().split('\n')) {
  const [table, , name, type, , , , charset] = line.split('\t')
  let kind: Kind
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
    const value = values[i]
    const { kind } = columns[i]
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
  const child = spawn('docker', [...mysqlArgs, query], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.kill()
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
    const countText = mysql(`SELECT COUNT(*) FROM ${quoteMy(table)}`).trim()
    if (!/^\d+$/.test(countText)) throw new Error(`Invalid source count for ${table}`)
    const expectedCount = BigInt(countText)
    const sourceHash = createHash('sha256')
    let sourceCount = 0n
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
    const insert = db.prepare(
      `INSERT INTO ${quoteSqlite(destination)} (${columns.map(({ name }) => quoteSqlite(name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    const exportHash = createHash('sha256')
    let exportCount = 0n
    await scan(query, table, columns, (values) => {
      hashRow(exportHash, columns, values)
      insert.run(...values)
      exportCount++
    })

    const select = db.prepare(
      `SELECT ${columns.map(({ name }) => quoteSqlite(name)).join(',')} FROM ${quoteSqlite(destination)} ORDER BY rowid`
    )
    select.setReadBigInts(true)
    const sqliteHash = createHash('sha256')
    let sqliteCount = 0n
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
  await [...tables].reduce(
    (previous, [table, columns]) => previous.then(() => exportTable(table, columns)),
    Promise.resolve()
  )
  const pin = '2948c203faa0d23c4772441119ebe98e5b7cad95'
  const sha256 = '748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9'
  const pins = db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()
  if (!pins || typeof pins.value !== 'string') throw new Error('Reference input pins are missing')
  metadata.run('input_pins', JSON.stringify({ ...JSON.parse(pins.value), world: pin }))
  metadata.run(
    'world.mysql_image',
    'mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565'
  )
  db.prepare(
    'INSERT INTO source (name, pin, sha256, licence, attribution) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'world',
    pin,
    sha256,
    'GPL-2.0-or-later; data may have additional rights; see world/azerothcore-LICENSE.txt',
    'AzerothCore authors; see world/azerothcore-AUTHORS.txt. Modified by conversion to SQLite. Corresponding source: https://github.com/azerothcore/azerothcore-wotlk/tree/2948c203faa0d23c4772441119ebe98e5b7cad95'
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
