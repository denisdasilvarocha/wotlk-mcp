import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

function runner(dir: string): string {
  const file = path.join(dir, 'run-world.ts')

  writeFileSync(
    file,
    `import { importWorld } from ${JSON.stringify(path.resolve('build/world/index.ts'))}
await importWorld(process.argv[2], { directory: ${JSON.stringify(dir)}, archive: 'fixture', revision: '${'a'.repeat(40)}', sha256: '${'b'.repeat(64)}' }, 'acore/importer@sha256:${'c'.repeat(64)}', process.argv[3])
`
  )
  mkdirSync(path.join(dir, 'data/sql/custom'), { recursive: true })
  mkdirSync(path.join(dir, 'modules'), { recursive: true })

  return file
}

function encodeRows(
  schema: string,
  rows: string,
  fixtures: Readonly<Record<string, Readonly<Record<string, string | ArrayLike<number> | null>>>>
): void {
  const columns = new Map<string, { name: string; type: string; nullable: boolean }[]>()
  for (const line of readFileSync(schema, 'utf8').trimEnd().split('\n')) {
    const [table, , name, type, nullable] = line.split('\t')
    if (!(table in fixtures)) {
      continue
    }
    const entries = columns.get(table) ?? []
    entries.push({ name, nullable: nullable === 'YES', type })
    columns.set(table, entries)
  }
  for (const [table, entries] of columns) {
    const encoded = entries.map(
      ({ name, type, nullable }: Readonly<{ name: string; type: string; nullable: boolean }>) => {
        const values = fixtures[table]
        let value = values[name]
        if (!Object.hasOwn(values, name)) {
          value = ''
          if (nullable) {
            value = null
          } else if (/^(tinyint|smallint|mediumint|int|bigint|float|double|real)\b/u.test(type)) {
            value = '0'
          }
        }
        if (value === null) {
          return 'N'
        }
        const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
        return `V${bytes.toString('hex').toUpperCase()}`
      }
    )
    writeFileSync(path.join(rows, table), `${encoded.join('\t')}\n`)
  }
}

function sourceKey(id: unknown): string {
  return id === 'quest:303' ? 'ID' : 'entry'
}

test('exported artifact preserves world rows and indexes only curated templates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-export-'))

  try {
    const bin = path.join(dir, 'bin')
    const rows = path.join(dir, 'rows')
    const database = path.join(dir, 'reference.sqlite')
    const world = path.join(dir, 'data/world')
    const sqlNull = null

    mkdirSync(bin)
    mkdirSync(rows)
    mkdirSync(path.join(dir, 'data'))
    cpSync('data/world', world, { recursive: true })

    const exporter = runner(dir)
    const schema = path.join(world, 'schema-columns.tsv')

    writeFileSync(
      schema,
      `${readFileSync(schema, 'utf8')}synthetic_types\t1\tamount\tdecimal(30,10)\tNO\tNULL\t\t\t\nsynthetic_types\t2\tpayload\tvarbinary(8)\tNO\tNULL\t\t\t\nsynthetic_types\t3\tmissing\tvarchar(10)\tYES\tNULL\t\tutf8mb4\tutf8mb4_unicode_ci\nsynthetic_types\t4\tcreated\tdatetime\tNO\tNULL\t\t\t\nsynthetic_types\t5\tnegative_zero\tdouble\tNO\tNULL\t\t\t\nsynthetic_types\t6\tfraction\tfloat\tNO\tNULL\t\t\t\n`
    )

    const fixtures: Record<string, Record<string, string | Buffer | null>> = {
      creature: {
        Comment: 'Snow\n雪',
        areaId: '3',
        guid: '11',
        id: '101',
        map: '1',
        position_x: '-123.5',
        position_y: '0.25',
        position_z: '4.5',
        zoneId: '2'
      },
      creature_template: {
        entry: '101',
        maxlevel: '14',
        minlevel: '12',
        name: 'Frost Warden',
        subname: 'Keeper'
      },
      game_event: {
        description: 'event',
        end_time: sqlNull,
        eventEntry: '1',
        length: '9007199254740993',
        occurence: '18446744073709551615',
        start_time: '0000-00-00 00:00:00'
      },
      gameobject: {
        areaId: '0',
        guid: '12',
        id: '404',
        map: '530',
        position_x: '1.5',
        position_y: '-2.25',
        position_z: '3',
        zoneId: '0'
      },
      gameobject_template: {
        castBarCaption: 'Opening frostbound lock',
        entry: '404',
        name: 'Ancient Chest'
      },
      item_template: {
        ItemLevel: '35',
        Quality: '3',
        description: 'A snowy souvenir',
        entry: '202',
        name: 'Silver Token'
      },
      quest_template: {
        ID: '303',
        LogDescription: 'Follow the northern lights',
        LogTitle: 'Frozen Trail',
        QuestLevel: '20',
        QuestSortID: '-12'
      },
      spell_dbc: { ID: '777', ShapeshiftMask: '18446744073709551615' },
      synthetic_types: {
        amount: '12345678901234567890.1234567890',
        created: '0000-00-00 00:00:00',
        fraction: '0.10000000149011612',
        missing: sqlNull,
        negative_zero: '0',
        payload: Buffer.from([0, 127, 128, 255])
      }
    }
    encodeRows(schema, rows, fixtures)

    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
case "$1" in rm|network) exit 0 ;; esac
for query do :; done
case "$query" in
  *'SELECT VERSION()'*) printf '%s\\n' '8.4.3	ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION	+00:00	utf8mb4	utf8mb4_general_ci'; exit ;;
  *information_schema.columns*) cat "$WORLD_ROOT/schema-columns.tsv"; exit ;;
  *information_schema.statistics*) cat "$WORLD_ROOT/schema-indexes.tsv"; exit ;;
esac
table=\${query#*' FROM \`'}
table=\${table%%'\`'*}
case "$query" in
  'SELECT COUNT('* ) if [ "$WORLD_MISMATCH" = 1 ]; then echo 1; elif [ -f "$WORLD_ROWS/$table" ]; then echo 1; else echo 0; fi ;;
  * ) if [ -f "$WORLD_ROWS/$table" ]; then cat "$WORLD_ROWS/$table"; fi ;;
esac
`,
      { mode: 0o755 }
    )
    initReference(database)

    const result = spawnSync('vpx', [exporter, database, path.join(dir, 'work')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        WORLD_ROOT: world,
        WORLD_ROWS: rows
      }
    })

    expect(result.status).toBe(0)

    const db = new DatabaseSync(database, { readOnly: true })

    try {
      expect(
        db.prepare("SELECT pin, sha256, attribution FROM source WHERE name = 'world'").get()
      ).toMatchObject({
        attribution: expect.stringContaining(
          `https://github.com/azerothcore/azerothcore-wotlk/tree/${'a'.repeat(40)}`
        ) as unknown,
        pin: 'a'.repeat(40),
        sha256: 'b'.repeat(64)
      })
      expect(db.prepare("SELECT value FROM meta WHERE key = 'world.importer_image'").get()).toEqual(
        {
          value: `acore/importer@sha256:${'c'.repeat(64)}`
        }
      )

      const indexed = db
        .prepare(
          "SELECT id, name, source_table, source_row, search_text, hint FROM record WHERE kind IN ('creature', 'item', 'quest', 'gameobject') ORDER BY id"
        )
        .all()

      expect(indexed).toHaveLength(4)
      expect(indexed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hint: expect.stringContaining('12-14') as unknown,
            id: 'creature:101',
            name: 'Frost Warden',
            search_text: 'Keeper',
            source_table: 'world_creature_template'
          }),
          expect.objectContaining({
            hint: expect.stringContaining('35') as unknown,
            id: 'item:202',
            name: 'Silver Token',
            search_text: 'A snowy souvenir',
            source_table: 'world_item_template'
          }),
          expect.objectContaining({
            hint: expect.stringContaining('-12') as unknown,
            id: 'quest:303',
            name: 'Frozen Trail',
            search_text: 'Follow the northern lights',
            source_table: 'world_quest_template'
          }),
          expect.objectContaining({
            id: 'gameobject:404',
            name: 'Ancient Chest',
            search_text: 'Opening frostbound lock',
            source_table: 'world_gameobject_template'
          })
        ])
      )

      for (const row of indexed) {
        const key = sourceKey(row.id)

        const source = db
          .prepare(`SELECT "${key}" AS key FROM "${String(row.source_table)}" WHERE rowid = ?`)
          .get(Number(row.source_row))

        expect(source).toMatchObject({ key: Number(String(row.id).split(':')[1]) })
      }

      expect(
        db.prepare("SELECT id FROM record_fts WHERE record_fts MATCH 'snowy'").get()
      ).toMatchObject({ id: 'item:202' })
      expect(
        db.prepare("SELECT count(*) AS n FROM record WHERE source_table LIKE '%_dbc'").get()
      ).toMatchObject({ n: 0 })
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('world_smart_scripts', 'world_creature_locale', 'world_waypoint_data', 'world_updates')"
          )
          .get()
      ).toMatchObject({ n: 0 })
      expect(
        db
          .prepare(
            'SELECT id, map, zoneId, areaId, position_x, position_y, position_z, Comment FROM world_creature'
          )
          .get()
      ).toMatchObject({
        Comment: 'Snow\n雪',
        areaId: 3,
        id: 101,
        map: 1,
        position_x: -123.5,
        position_y: 0.25,
        position_z: 4.5,
        zoneId: 2
      })
      expect(
        db
          .prepare(
            'SELECT id, map, zoneId, areaId, position_x, position_y, position_z FROM world_gameobject'
          )
          .get()
      ).toMatchObject({
        areaId: 0,
        id: 404,
        map: 530,
        position_x: 1.5,
        position_y: -2.25,
        position_z: 3,
        zoneId: 0
      })
      expect(
        db.prepare('SELECT start_time, end_time, occurence, length FROM world_game_event').get()
      ).toMatchObject({
        end_time: sqlNull,
        length: '9007199254740993',
        occurence: '18446744073709551615',
        start_time: '0000-00-00 00:00:00'
      })
      expect(
        db
          .prepare(
            'SELECT amount, payload, missing, created, negative_zero, fraction FROM world_synthetic_types'
          )
          .get()
      ).toMatchObject({
        amount: '12345678901234567890.1234567890',
        created: '0000-00-00 00:00:00',
        fraction: 0.10000000149011612,
        missing: sqlNull,
        negative_zero: 0,
        payload: new Uint8Array([0, 127, 128, 255])
      })
      expect(db.prepare('SELECT ID, ShapeshiftMask FROM world_spell_dbc').get()).toMatchObject({
        ID: 777,
        ShapeshiftMask: '18446744073709551615'
      })
    } finally {
      db.close()
    }

    unpackPackage(dir)

    const client = new Client({ name: 'world-test', version: '1' })

    await client.connect(packagedServer(dir, database))

    try {
      const response = await client.callTool({
        arguments: { ids: ['creature:101', 'item:202', 'quest:303', 'gameobject:404'] },
        name: 'get'
      })

      expect(response.isError).not.toBe(true)
      expect(JSON.stringify(response.content)).toContain('Frost Warden')
      expect(JSON.stringify(response.content)).toContain('A snowy souvenir')
      expect(JSON.stringify(response.content)).toContain('Frozen Trail')
      expect(JSON.stringify(response.content)).toContain('Ancient Chest')
    } finally {
      await client.close()
    }

    const failedDatabase = path.join(dir, 'failed.sqlite')

    initReference(failedDatabase)

    const failed = spawnSync('vpx', [exporter, failedDatabase, path.join(dir, 'failed-work')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        WORLD_MISMATCH: '1',
        WORLD_ROOT: world,
        WORLD_ROWS: rows
      }
    })

    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('count or logical hash mismatch')

    const rolledBack = new DatabaseSync(failedDatabase, { readOnly: true })

    try {
      expect(
        rolledBack
          .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'world_%'")
          .get()
      ).toMatchObject({ n: 0 })
    } finally {
      rolledBack.close()
    }

    const edgeFile = path.join(rows, 'synthetic_types')
    const edgeFields = readFileSync(edgeFile, 'utf8').trimEnd().split('\t')

    edgeFields[4] = 'V2D30'
    writeFileSync(edgeFile, `${edgeFields.join('\t')}\n`)

    const loss = spawnSync('vpx', [exporter, failedDatabase, path.join(dir, 'loss-work')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        WORLD_ROOT: world,
        WORLD_ROWS: rows
      }
    })

    expect(loss.status).not.toBe(0)
    expect(loss.stderr).toContain(
      'World floating conversion loss in synthetic_types.negative_zero: -0'
    )

    const afterLoss = new DatabaseSync(failedDatabase, { readOnly: true })

    try {
      expect(
        afterLoss.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'world_%'").get()
      ).toMatchObject({ n: 0 })
    } finally {
      afterLoss.close()
    }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 120_000)

test('exporter reports a failed MySQL command without changing the reference', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-export-'))

  try {
    const bin = path.join(dir, 'bin')
    const database = path.join(dir, 'reference.sqlite')

    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'docker'),
      '#!/bin/sh\necho fixture-mysql-failure >&2\nexit 42\n',
      {
        mode: 0o755
      }
    )
    initReference(database)

    const exporter = runner(dir)
    const before = new DatabaseSync(database)
    const count = before.prepare('SELECT count(*) AS n FROM record').get()

    before.close()

    const result = spawnSync('vpx', [exporter, database, path.join(dir, 'work')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    })

    expect(result.status).not.toBe(0)

    const after = new DatabaseSync(database, { readOnly: true })

    expect(after.prepare('SELECT count(*) AS n FROM record').get()).toEqual(count)
    expect(
      after.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'world_%'").get()
    ).toEqual({ n: 0 })
    after.close()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
