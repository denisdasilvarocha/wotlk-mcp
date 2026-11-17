import { canonicalTableHash, canonicalTables } from '../build/shared/table-hash.ts'
import {
  checkFullText,
  checkSources,
  checkVocabulary,
  counts,
  fail,
  metadata,
  pins,
  rows,
  schema
} from './release-gate-checks.ts'
import { changedRecordIds, compareSchemas } from './release-gate-comparison.ts'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createBrotliDecompress } from 'node:zlib'

function assertEmpty(sql: string, error: string): void {
  if (db.prepare(sql).get()) {
    fail(error)
  }
}

let usedVersions: unknown = []
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const prepare = args.includes('--prepare')
const allowShrink = args.includes('--allow-shrink')
const usedVersionsFile = args.find((arg) => arg.startsWith('--used-versions='))?.slice(16)
const options = args.filter((arg) => arg.startsWith('--'))

if (
  options.some(
    (arg) => !['--prepare', '--allow-shrink'].includes(arg) && !arg.startsWith('--used-versions=')
  )
) {
  throw new Error('Unknown option')
}

const positional = args.filter((arg) => !arg.startsWith('--'))
const [database, asset, previous] = positional
let old: DatabaseSync | undefined

if (!database || (!prepare && !asset) || positional.length > 3) {
  throw new Error(
    'Usage: release-gate <database> <asset.br> [previous.sqlite] [--prepare] [--allow-shrink] [--used-versions=versions.json]'
  )
}

if (usedVersionsFile !== undefined) {
  usedVersions = JSON.parse(readFileSync(usedVersionsFile, 'utf8'))
}

if (!Array.isArray(usedVersions)) {
  throw new TypeError('Invalid used versions')
}
const db = new DatabaseSync(database)

if (previous) {
  old = new DatabaseSync(previous, { readOnly: true })
}
try {
  const kindSet = checkVocabulary(db, assertEmpty)
  const sourceTables = new Set(canonicalTables(db))
  checkSources(db, sourceTables)
  checkFullText(db, assertEmpty)

  const currentPins = pins(db)
  const currentCounts = counts(db)
  const declaredHashes = rows(
    db,
    "SELECT key,value FROM meta WHERE key LIKE 'canonical_hash.%' OR key LIKE 'canonical_count.%'"
  )
  const declarations = new Map(
    declaredHashes.map((row: Readonly<Record<string, unknown>>) => [
      String(row.key),
      String(row.value)
    ])
  )

  if (declarations.size !== sourceTables.size * 2) {
    fail('Incomplete canonical hash metadata')
  }

  for (const name of sourceTables) {
    const { hash, count } = canonicalTableHash(db, name)

    if (
      declarations.get(`canonical_hash.${name}`) !== hash ||
      declarations.get(`canonical_count.${name}`) !== count
    ) {
      fail(`Invalid canonical hash or count: ${name}`)
    }
  }

  let change = 'first'
  let version = '1.0.0'

  if (old && previous) {
    const previousVersion = metadata(old, 'schema_version')
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(previousVersion) ??
      fail('Invalid previous schema version')
    const after = schema(db),
      before = schema(old)
    const { addition, breaking: schemaBreaking } = compareSchemas(before, after, old, kindSet)
    const idsChanged = changedRecordIds(db, previous, before, after)
    const breaking = schemaBreaking || idsChanged

    const [major, minor, patch] = match.slice(1).map(Number)

    change = 'patch'
    version = `${major}.${minor}.${patch + 1}`

    if (breaking) {
      change = 'major'
      version = `${major + 1}.0.0`
    } else if (addition) {
      change = 'minor'
      version = `${major}.${minor + 1}.0`
    }

    const previousCounts = counts(old)

    const shrunk = Object.entries(previousCounts).find(
      ([key, count]: readonly [string, number]) => (currentCounts[key] ?? 0) * 100 < count * 95
    )
    if (!allowShrink && shrunk !== undefined) {
      fail(`Excessive shrink: ${shrunk[0]}`)
    }

    if (currentPins === pins(old)) {
      const afterTables = canonicalTables(db),
        beforeTables = canonicalTables(old)

      if (JSON.stringify(beforeTables) !== JSON.stringify(afterTables)) {
        fail('Unchanged input pins with logical drift')
      }

      const drift = afterTables.find(
        (name) => canonicalTableHash(db, name).hash !== canonicalTableHash(old, name).hash
      )
      if (drift !== undefined) {
        fail(`Unchanged input pins with logical drift: ${drift}`)
      }
    }
  }

  let [major, minor, patch] = version.split('.').map(Number)

  for (const used of usedVersions) {
    if (typeof used !== 'string') {
      fail('Invalid used version')
    }

    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(used)

    if (!match) {
      fail('Invalid used version')
    }

    const [usedMajor, usedMinor, usedPatch] = match.slice(1).map(Number)

    if (usedMajor === major && (usedMinor > minor || (usedMinor === minor && usedPatch >= patch))) {
      minor = usedMinor
      patch = usedPatch + 1
    }
  }

  version = `${major}.${minor}.${patch}`

  if (prepare) {
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(version)
  } else if (metadata(db, 'schema_version') !== version) {
    fail(
      `Insufficient or incorrect schema version; required ${version}; run --prepare and recompress`
    )
  }

  db.close()
  old?.close()

  let compressedBytes: number | undefined

  if (!prepare) {
    compressedBytes = statSync(asset).size

    if (compressedBytes > 250_000_000) {
      fail('Compressed asset exceeds 250 MB')
    }

    const actual = createHash('sha256'),
      decoded = createHash('sha256')

    for await (const chunk of createReadStream(database)) {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
        throw new TypeError('Invalid database chunk')
      }
      actual.update(chunk)
    }

    for await (const chunk of createReadStream(asset).pipe(createBrotliDecompress())) {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
        throw new TypeError('Invalid database chunk')
      }
      decoded.update(chunk)
    }

    if (actual.digest('hex') !== decoded.digest('hex')) {
      fail('Compressed asset does not contain the candidate database')
    }
  }

  console.log(
    JSON.stringify({
      allow_shrink: allowShrink,
      change,
      compressed_bytes: compressedBytes,
      counts: currentCounts,
      uncompressed_bytes: statSync(database).size,
      version
    })
  )
} finally {
  if (db.isOpen) {
    db.close()
  }

  if (old?.isOpen === true) {
    old.close()
  }
}
