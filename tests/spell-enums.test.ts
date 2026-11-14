import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test('spell mappings validate fields and materialize named references without changing raw data', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spell-enums-'))
  try {
    const database = path.join(dir, 'reference.sqlite')
    execFileSync('vpx', ['scripts/build-reference.ts', database])
    const db = new DatabaseSync(database)
    const columns = [
      'Attributes',
      'AttributesEx',
      'AttributesExB',
      'AttributesExC',
      'AttributesExD',
      'AttributesExE',
      'AttributesExF',
      'AttributesExG',
      'Targets',
      'TargetCreatureType',
      'InterruptFlags',
      'AuraInterruptFlags',
      'ChannelInterruptFlags',
      'ProcTypeMask',
      'PowerType',
      'SchoolMask',
      ...[1, 2, 3].flatMap((i) => [
        `Effect_${i}`,
        `EffectAura_${i}`,
        `ImplicitTargetA_${i}`,
        `ImplicitTargetB_${i}`
      ])
    ]
    db.exec(
      `CREATE TABLE dbc_Spell (ID INTEGER, Name_lang TEXT, ${columns.map((x) => `"${x}" INTEGER`).join(', ')}, Category INTEGER, Missing INTEGER); INSERT INTO dbc_Spell (ID, Name_lang, Effect_1, Effect_2, Effect_3, EffectAura_1, EffectAura_2, EffectAura_3, ImplicitTargetA_1, ImplicitTargetA_2, ImplicitTargetA_3, Attributes, AttributesExG, SchoolMask, ProcTypeMask, PowerType, Category, Missing) VALUES (1, 'Example', 1, 2, 9999, 1, 2, 1, 1, 2, 1, 9, 2, 1, 2, -1, 4, 7); INSERT INTO record VALUES ('spell:1', 'spell', 'Example', 'dbc_Spell', 1, '', ''); CREATE TABLE dbc_Category (ID INTEGER, Name_lang TEXT); INSERT INTO dbc_Category VALUES (4, 'Example category'); CREATE TABLE dbc_foreign_key (source_table TEXT, field TEXT, target_table TEXT, target_field TEXT); INSERT INTO dbc_foreign_key VALUES ('dbc_Spell', 'Category', 'dbc_Category', 'ID'), ('dbc_Spell', 'Missing', 'dbc_Category', 'ID');`
    )
    db.close()
    const root = 'azerothcore-wotlk-2948c203faa0d23c4772441119ebe98e5b7cad95'
    const headerNames: Record<string, string[]> = {
      'src/server/shared/SharedDefines.h': [
        'SpellSchools',
        'SpellSchoolMask',
        'SpellEffects',
        'Targets',
        'Powers',
        'CreatureType',
        ...Array.from({ length: 8 }, (_, i) => `SpellAttr${i}`)
      ],
      'src/server/game/Spells/Auras/SpellAuraDefines.h': ['AuraType'],
      'src/server/game/Spells/SpellDefines.h': [
        'SpellInterruptFlags',
        'SpellAuraInterruptFlags',
        'SpellChannelInterruptFlags'
      ],
      'src/server/game/Spells/SpellInfo.h': ['SpellCastTargetFlags'],
      'src/server/game/Spells/SpellMgr.h': ['ProcFlags']
    }
    for (const [file, names] of Object.entries(headerNames)) {
      const destination = path.join(dir, root, file)
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(
        destination,
        names
          .map(
            (name) =>
              `enum ${name} { ${name.toUpperCase()}_NONE = 0, ${name.toUpperCase()}_FIRST = 1, ${name.toUpperCase()}_SECOND = 2 };`
          )
          .join('\n')
      )
    }
    const archive = path.join(dir, 'source.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', dir, root])
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const command = path.join(dir, 'import-spell-enums.ts')
    writeFileSync(
      command,
      readFileSync('scripts/import-spell-enums.ts', 'utf8').replace(
        '748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9',
        digest
      )
    )
    cpSync('scripts/world-enum-parser.ts', path.join(dir, 'world-enum-parser.ts'))
    symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
    const result = spawnSync('vpx', [command, database, archive], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    const output = new DatabaseSync(database)
    expect(
      output
        .prepare("SELECT value, name FROM enum_value WHERE enum_name = 'reference.dbc_Category.ID'")
        .all()
    ).toEqual([{ value: 4, name: 'Example category' }])
    expect(
      output.prepare('SELECT Effect_1, Effect_2, Effect_3, Category FROM dbc_Spell').get()
    ).toMatchObject({ Effect_1: 1, Effect_2: 2, Effect_3: 9999, Category: 4 })
    expect(
      output
        .prepare(
          "SELECT count(*) AS n FROM enum_field WHERE source_table = 'dbc_Spell' AND field LIKE 'Effect_%' AND enum_name = 'SpellEffects'"
        )
        .get()?.n
    ).toBe(3)
    expect(
      output
        .prepare(
          "SELECT count(*) AS n FROM enum_field WHERE source_table = 'dbc_Spell' AND enum_name LIKE 'SpellAttr_'"
        )
        .get()?.n
    ).toBe(8)
    expect(
      output
        .prepare(
          "SELECT count(*) AS n FROM enum_field WHERE source_table = 'dbc_Spell' AND enum_name = 'Targets'"
        )
        .get()?.n
    ).toBe(6)
    output.close()
    execFileSync('vp', ['pm', 'pack', '--pack-destination', dir])
    const archiveName = (await import('node:fs'))
      .readdirSync(dir)
      .find((name) => name.endsWith('.tgz'))
    if (!archiveName) throw new Error('Package archive not created')
    execFileSync('tar', ['-xzf', path.join(dir, archiveName), '-C', dir])
    symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'dir')
    const client = new Client({ name: 'test-spell', version: '1' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(dir, 'package/dist/index.mjs')],
        env: { ...process.env, WOTLK_MCP_DB: database }
      })
    )
    try {
      const get = JSON.stringify(
        await client.callTool({ name: 'get', arguments: { ids: ['spell:1'] } })
      )
      for (const expected of [
        'Effect_1: 1 (FIRST)',
        'Effect_2: 2 (SECOND)',
        'Effect_3: 9999',
        'EffectAura_3: 1 (FIRST)',
        'ImplicitTargetA_2: 2 (SECOND)',
        'Attributes: 9 (FIRST, 8)',
        'AttributesExG: 2 (SECOND)',
        'PowerType: -1',
        'Category: 4 (Example category)',
        'Missing: 7'
      ])
        expect(get).toContain(expected)
      const sql = JSON.stringify(
        await client.callTool({
          name: 'sql',
          arguments: {
            query: 'SELECT Effect_1, Effect_2, Effect_3, Attributes, Category FROM dbc_Spell'
          }
        })
      )
      expect(sql).toContain('1\\t2\\t9999\\t9\\t4')
    } finally {
      await client.close()
    }
    const invalid = new DatabaseSync(database)
    invalid.exec('ALTER TABLE dbc_Spell DROP COLUMN Effect_3')
    invalid.close()
    const failure = spawnSync('vpx', [command, database, archive], { encoding: 'utf8' })
    expect(failure.status).not.toBe(0)
    expect(failure.stderr).toContain('Missing mapped column dbc_Spell.Effect_3')
    const restored = new DatabaseSync(database)
    restored.exec('ALTER TABLE dbc_Spell ADD COLUMN Effect_3 INTEGER')
    restored.close()
    const shared = path.join(dir, root, 'src/server/shared/SharedDefines.h')
    writeFileSync(
      shared,
      readFileSync(shared, 'utf8').replace('enum SpellEffects', 'enum RemovedSpellEffects')
    )
    execFileSync('tar', ['-czf', archive, '-C', dir, root])
    const changedDigest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(command, readFileSync(command, 'utf8').replace(digest, changedDigest))
    const missingEnum = spawnSync('vpx', [command, database, archive], { encoding: 'utf8' })
    expect(missingEnum.status).not.toBe(0)
    expect(missingEnum.stderr).toContain('Missing pinned enum SpellEffects')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
