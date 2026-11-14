import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vite-plus/test'

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

test('Client Data importer preserves wide values and SQL-only Item, and verifies hashes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-dbc-'))
  const client = new Client({ name: 'test', version: '1' })
  try {
    const db = path.join(dir, 'reference.sqlite')
    execFileSync('vpx', ['scripts/build-reference.ts', db])
    mkdirSync(path.join(dir, 'DBFilesClient'))
    mkdirSync(path.join(dir, 'fixture', 'definitions'), { recursive: true })
    const files: { path: string; sha256: string }[] = []
    function make(
      name: string,
      definitions: string[],
      layout: string[],
      values: number[],
      strings = '\0'
    ): void {
      const def = `COLUMNS\n${definitions.join('\n')}\n\nBUILD 3.3.5.12340\n${layout.join('\n')}\n`
      writeFileSync(path.join(dir, 'fixture', 'definitions', `${name}.dbd`), def)
      const str = Buffer.from(strings)
      const dbc = Buffer.alloc(20 + values.length * 4 + str.length)
      dbc.write('WDBC')
      dbc.writeUInt32LE(1, 4)
      dbc.writeUInt32LE(values.length, 8)
      dbc.writeUInt32LE(values.length * 4, 12)
      dbc.writeUInt32LE(str.length, 16)
      values.forEach((value, i) => dbc.writeUInt32LE(value, 20 + i * 4))
      str.copy(dbc, 20 + values.length * 4)
      const file = `DBFilesClient/${name}.dbc`
      writeFileSync(path.join(dir, file), dbc)
      files.push({ path: file, sha256: digest(dbc) })
    }
    make(
      'Spell',
      ['int ID', 'string Name_lang', 'string Description_lang', 'int Effect'],
      ['$id$ID<32>', 'Name_lang', 'Description_lang', 'Effect<32>[3]'],
      [123, 1, 10, 10, 20, 30],
      '\0Fireball\0Burns\0'
    )
    make(
      'Talent',
      ['int ID', 'int<TalentTab::ID> TabID', 'int SpellRank'],
      ['$id$ID<32>', 'TabID<32>', 'SpellRank<32>[2]'],
      [5, 7, 123, 0]
    )
    make(
      'TalentTab',
      ['int ID', 'string Name_lang'],
      ['$id$ID<32>', 'Name_lang'],
      [7, 1],
      '\0Fire\0'
    )
    make('Item', ['int ID', 'int ClassID'], ['$id$ID<32>', 'ClassID<32>'], [42, 2])
    for (const name of [
      'ItemSet',
      'SkillLine',
      'Map',
      'AreaTable',
      'Faction',
      'ChrClasses',
      'ChrRaces',
      'Achievement'
    ])
      make(name, ['int ID', 'string Name_lang'], ['$id$ID<32>', 'Name_lang'], [1, 0])
    const archive = path.join(dir, 'definitions.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', dir, 'fixture'])
    const source = readFileSync('scripts/import-client-data.ts', 'utf8').replace(
      'b35205cb31c27204f05ae8528ca214af02381585f5d0d2697bea30a2d58123ca',
      digest(readFileSync(archive))
    )
    const script = path.join(dir, 'import-client-data.ts')
    writeFileSync(script, source)
    const manifest = JSON.stringify({
      client: {
        build: 12340,
        locale: 'enGB',
        original_executable_sha256:
          'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
      },
      files
    })
    writeFileSync(path.join(dir, 'manifest.json'), manifest)
    const args = [script, db, dir, digest(manifest), archive]
    execFileSync('vpx', args, { stdio: 'pipe' })
    const result = new DatabaseSync(db, { readOnly: true })
    expect(result.prepare('SELECT Effect_1, Effect_2, Effect_3 FROM dbc_Spell').get()).toEqual({
      Effect_1: 10,
      Effect_2: 20,
      Effect_3: 30
    })
    expect(result.prepare('SELECT ID, ClassID FROM dbc_Item').get()).toEqual({ ID: 42, ClassID: 2 })
    expect(result.prepare("SELECT count(*) AS n FROM record WHERE kind = 'item'").get()?.n).toBe(0)
    expect(result.prepare("SELECT name, hint FROM record WHERE id = 'talent:5'").get()).toEqual({
      name: 'Fireball',
      hint: 'Fire'
    })
    result.close()
    execFileSync('vp', ['pm', 'pack', '--pack-destination', dir], { stdio: 'pipe' })
    const packed = readdirSync(dir).find((name) => name.endsWith('.tgz'))
    if (!packed) throw new Error('Package archive not created')
    execFileSync('tar', ['-xzf', path.join(dir, packed), '-C', dir])
    symlinkSync(path.resolve('node_modules'), path.join(dir, 'package', 'node_modules'), 'dir')
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(dir, 'package', 'dist/index.mjs')],
        env: { ...process.env, WOTLK_MCP_DB: db }
      })
    )
    const output = await client.callTool({
      name: 'get',
      arguments: { ids: ['spell:123', 'talent:5'] }
    })
    expect(JSON.stringify(output)).toContain('Effect_3: 30')
    expect(JSON.stringify(output)).toContain('TalentTab_Name_lang: Fire')
    const itemFile = path.join(dir, 'DBFilesClient', 'Item.dbc')
    const originalItem = readFileSync(itemFile)
    writeFileSync(path.join(dir, 'DBFilesClient', 'Item.dbc'), Buffer.from('invalid'))
    const other = path.join(dir, 'other.sqlite')
    execFileSync('vpx', ['scripts/build-reference.ts', other])
    expect(() =>
      execFileSync('vpx', [script, other, dir, digest(manifest), archive], { stdio: 'pipe' })
    ).toThrow(/hash mismatch/)
    const badSchema = Buffer.from(originalItem)
    badSchema.writeUInt32LE(3, 8)
    writeFileSync(itemFile, badSchema)
    const schemaManifest = manifest.replace(digest(originalItem), digest(badSchema))
    writeFileSync(path.join(dir, 'manifest.json'), schemaManifest)
    expect(() =>
      execFileSync('vpx', [script, other, dir, digest(schemaManifest), archive], { stdio: 'pipe' })
    ).toThrow(/schema mismatch/)
    writeFileSync(itemFile, originalItem)
    const missingManifest = manifest.replace(
      /,?\{"path":"DBFilesClient\/ItemSet\.dbc","sha256":"[a-f0-9]+"\}/,
      ''
    )
    writeFileSync(path.join(dir, 'manifest.json'), missingManifest)
    expect(() =>
      execFileSync('vpx', [script, other, dir, digest(missingManifest), archive], { stdio: 'pipe' })
    ).toThrow(/Missing required Client Data/)
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
