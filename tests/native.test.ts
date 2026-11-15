import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/client'
import { expect, test } from 'vite-plus/test'

import { importNative } from '../build/native.ts'
import { initReference } from '../build/offsets.ts'
import { packagedServer, unpackPackage } from './package.ts'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test('native facts retain contexts and only link verified equal curated VAs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-'))
  const client = new Client({ name: 'native-test', version: '1' })

  try {
    const database = path.join(dir, 'db.sqlite')

    initReference(database)

    const db = new DatabaseSync(database)
    const registrations = [
      {
        kind: 'global',
        name: 'Foo',
        va: '0x00400002',
        context: 'game',
        table: '0x00401000',
        index: 0,
        call_sites: ['0x00402000']
      },
      {
        kind: 'global',
        name: 'Foo',
        va: '0x00400003',
        context: 'glue',
        table: '0x00401000',
        index: 0,
        call_sites: ['0x00402000']
      },
      {
        kind: 'method',
        name: 'SetPoint',
        va: '0x00400004',
        context: 'game',
        table: '0x00403000',
        index: 0,
        call_sites: ['0x00402000']
      }
    ]

    db.exec(`CREATE TABLE lua_widget (name TEXT, methods TEXT, inherits TEXT DEFAULT '[]', inheritedMethods TEXT DEFAULT '[]'); INSERT INTO lua_widget (name,methods) VALUES ('Region','["SetPoint"]');
      CREATE TABLE lua_fn (name TEXT, memoryAddress TEXT); INSERT INTO lua_fn VALUES ('Foo','0x00400001');
      CREATE TABLE lua_method (name TEXT, declaringWidget TEXT); INSERT INTO lua_method VALUES ('SetPoint','Region');
      INSERT INTO record VALUES ('fn:Foo','fn','Foo','lua_fn',1,'',''), ('method:Region:SetPoint','method','SetPoint','lua_method',1,'','');
      INSERT INTO offsets_entry VALUES ('fixture-a','0x00400002','function','',NULL), ('fixture-b','0x00400002','function','',NULL), ('documentation-only','0x00400001','function','',NULL);
      INSERT INTO record VALUES ('offset:fixture-a','offset','fixture-a','offsets_entry',(SELECT rowid FROM offsets_entry WHERE path='fixture-a'),'',''), ('offset:fixture-b','offset','fixture-b','offsets_entry',(SELECT rowid FROM offsets_entry WHERE path='fixture-b'),'',''), ('offset:documentation-only','offset','documentation-only','offsets_entry',(SELECT rowid FROM offsets_entry WHERE path='documentation-only'),'','');`)
    db.close()

    const dump = JSON.stringify({
      format: 1,
      executable_sha256: 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8',
      image_base: '0x00400000',
      extraction: {},
      registrations
    })
    const manifest = JSON.stringify({
      format: 1,
      client: {
        original_executable_sha256:
          'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
      },
      files: [{ path: 'native-registrations.json', sha256: hash(dump) }]
    })

    writeFileSync(path.join(dir, 'native-registrations.json'), dump)
    writeFileSync(path.join(dir, 'manifest.json'), manifest)

    const exactDatabase = path.join(dir, 'exact.sqlite')

    copyFileSync(database, exactDatabase)
    importNative(exactDatabase, dir, hash(manifest))

    const exact = new DatabaseSync(exactDatabase, { readOnly: true })

    expect(
      exact.prepare("SELECT record_id FROM lua_native_registration WHERE kind='method'").get()
    ).toMatchObject({ record_id: 'method:Region:SetPoint' })
    exact.close()

    const inheritedDatabase = path.join(dir, 'inherited.sqlite')

    copyFileSync(database, inheritedDatabase)

    const inheritedSetup = new DatabaseSync(inheritedDatabase)

    inheritedSetup.exec(`UPDATE lua_widget SET methods='["Other"]', inherits='["Base"]', inheritedMethods='["SetPoint"]';
      INSERT INTO lua_widget (name,methods) VALUES ('Base','["SetPoint"]');
      INSERT INTO record VALUES ('method:Base:SetPoint','method','SetPoint','lua_method',1,'','');`)
    inheritedSetup.close()

    const inheritedDecision = path.join(dir, 'inherited.json')

    writeFileSync(
      inheritedDecision,
      JSON.stringify({
        overrides: {
          '0x00403000': {
            widget: 'Region',
            methods_sha256: hash(JSON.stringify(['SetPoint'])),
            reason: 'fixture type evidence'
          }
        },
        missing_widgets: {}
      })
    )
    importNative(inheritedDatabase, dir, hash(manifest), inheritedDecision)

    const inheritedResult = new DatabaseSync(inheritedDatabase, { readOnly: true })

    expect(
      inheritedResult
        .prepare("SELECT widget,record_id FROM lua_native_registration WHERE kind='method'")
        .get()
    ).toMatchObject({ widget: 'Region', record_id: 'method:Base:SetPoint' })
    inheritedResult.close()

    const rawDatabase = path.join(dir, 'raw.sqlite')

    copyFileSync(database, rawDatabase)

    const rawSetup = new DatabaseSync(rawDatabase)

    rawSetup.exec(`UPDATE lua_widget SET methods='["Different"]'`)
    rawSetup.close()

    const rawDecision = path.join(dir, 'raw.json')

    writeFileSync(
      rawDecision,
      JSON.stringify({
        overrides: {},
        missing_widgets: {
          '0x00403000': {
            widget: 'MissingWidget',
            methods_sha256: hash(JSON.stringify(['SetPoint'])),
            reason: 'fixture type evidence'
          }
        }
      })
    )
    importNative(rawDatabase, dir, hash(manifest), rawDecision)

    const raw = new DatabaseSync(rawDatabase, { readOnly: true })

    expect(
      raw
        .prepare(
          "SELECT count(*) AS n FROM lua_native_registration WHERE kind='method' AND widget IS NULL AND record_id IS NULL"
        )
        .get()
    ).toMatchObject({ n: 1 })
    expect(
      raw.prepare("SELECT count(*) AS n FROM link WHERE source_id LIKE 'method:%'").get()
    ).toMatchObject({ n: 0 })
    raw.close()

    function command(): void {
      importNative(database, dir, hash(manifest))
    }

    const update = new DatabaseSync(database)

    update.exec(`INSERT INTO lua_widget (name,methods) VALUES ('Other','["SetPoint"]')`)
    update.close()
    expect(command).toThrow('Unresolved widget table')

    const missing = new DatabaseSync(database)

    missing.exec(`UPDATE lua_widget SET methods='["Different"]'`)
    missing.close()
    expect(command).toThrow('no exact match')

    const restore = new DatabaseSync(database)

    restore.exec(`UPDATE lua_widget SET methods='["SetPoint"]'`)
    restore.close()

    const override = path.join(dir, 'overrides.json')

    writeFileSync(
      override,
      JSON.stringify({
        overrides: {
          '0x00403000': {
            widget: 'Region',
            methods_sha256: hash(JSON.stringify(['SetPoint'])),
            reason: 'fixture establishes declaring type'
          }
        },
        missing_widgets: {}
      })
    )
    importNative(database, dir, hash(manifest), override)

    const result = new DatabaseSync(database, { readOnly: true })

    expect(
      result
        .prepare(
          'SELECT context,va,record_id FROM lua_native_registration ORDER BY context, va, record_id'
        )
        .all()
    ).toEqual([
      { context: 'game', va: '0x00400002', record_id: 'fn:Foo' },
      { context: 'game', va: '0x00400004', record_id: 'method:Region:SetPoint' },
      { context: 'glue', va: '0x00400003', record_id: 'fn:Foo' }
    ])
    expect(
      result
        .prepare("SELECT destination_id FROM link WHERE source_id='fn:Foo' ORDER BY destination_id")
        .all()
    ).toEqual([{ destination_id: 'offset:fixture-a' }, { destination_id: 'offset:fixture-b' }])
    result.close()
    unpackPackage(dir)
    await client.connect(packagedServer(dir, database))

    const output = JSON.stringify(
      await client.callTool({ name: 'get', arguments: { ids: ['fn:Foo'] } })
    )

    expect(output).toContain('0x00400002 game 0x00401000[0]')
    expect(output).toContain('0x00400003 glue 0x00401000[0]')

    const related = JSON.stringify(
      await client.callTool({ name: 'related', arguments: { id: 'fn:Foo' } })
    )

    expect(related).toContain('offset:fixture-a')
    expect(related).toContain('offset:fixture-b')
    expect(related).not.toContain('offset:documentation-only')
  } finally {
    try {
      await client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
