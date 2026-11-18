import { importSpellEnums } from '../../build/enums/spell.ts'
import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.js'
import { Client } from '@modelcontextprotocol/client'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

test('spell mappings validate fields and materialize named references without changing raw data', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spell-enums-'))

  try {
    const database = path.join(dir, 'reference.sqlite')

    initReference(database)

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
    const root = 'azerothcore-wotlk-2948c203faa0d23c4772441119ebe98e5b7cad95'

    db.exec(
      `CREATE TABLE dbc_Spell (ID INTEGER, Name_lang TEXT, ${columns.map((x) => `"${x}" INTEGER`).join(', ')}, Category INTEGER, Missing INTEGER); INSERT INTO dbc_Spell (ID, Name_lang, Effect_1, Effect_2, Effect_3, EffectAura_1, EffectAura_2, EffectAura_3, ImplicitTargetA_1, ImplicitTargetA_2, ImplicitTargetA_3, Attributes, AttributesExG, SchoolMask, ProcTypeMask, PowerType, Category, Missing) VALUES (1, 'Example', 1, 2, 9999, 1, 2, 1, 1, 2, 1, 9, 2, 1, 2, -1, 4, 7); INSERT INTO record VALUES ('spell:1', 'spell', 'Example', 'dbc_Spell', 1, '', ''); CREATE TABLE dbc_Category (ID INTEGER, Name_lang TEXT); INSERT INTO dbc_Category VALUES (4, 'Example category'); CREATE TABLE dbc_foreign_key (source_table TEXT, field TEXT, target_table TEXT, target_field TEXT); INSERT INTO dbc_foreign_key VALUES ('dbc_Spell', 'Category', 'dbc_Category', 'ID'), ('dbc_Spell', 'Missing', 'dbc_Category', 'ID');`
    )
    db.exec(`
      CREATE TABLE dbc_Achievement (ID INTEGER, Title_lang TEXT, Supercedes INTEGER);
      INSERT INTO dbc_Achievement VALUES (6, 'Level 10', 0), (7, 'Level 20', 6);
      INSERT INTO dbc_foreign_key VALUES ('dbc_Achievement', 'Supercedes', 'dbc_Achievement', 'ID');
      INSERT INTO record VALUES ('achievement:7', 'achievement', 'Level 20', 'dbc_Achievement', 2, '', '');
    `)
    db.exec(
      'UPDATE dbc_Spell SET ImplicitTargetB_1 = 1, ImplicitTargetB_2 = 2, ImplicitTargetB_3 = 1, Targets = 1, TargetCreatureType = 2, InterruptFlags = 1, AuraInterruptFlags = 2, ChannelInterruptFlags = 1'
    )
    db.exec(`
      INSERT INTO dbc_Spell (ID, Name_lang, PowerType) VALUES (755, 'Health Funnel', -2);
      INSERT INTO record VALUES ('spell:755', 'spell', 'Health Funnel', 'dbc_Spell', 2, '', '');
    `)
    db.close()

    const headerNames: Record<string, string[]> = {
      'src/server/game/Spells/Auras/SpellAuraDefines.h': ['AuraType'],
      'src/server/game/Spells/SpellDefines.h': [
        'SpellInterruptFlags',
        'SpellAuraInterruptFlags',
        'SpellChannelInterruptFlags'
      ],
      'src/server/game/Spells/SpellInfo.h': ['SpellCastTargetFlags'],
      'src/server/game/Spells/SpellMgr.h': ['ProcFlags'],
      'src/server/shared/SharedDefines.h': [
        'SpellSchools',
        'SpellSchoolMask',
        'SpellEffects',
        'Targets',
        'Powers',
        'CreatureType',
        ...Array.from({ length: 8 }, (_, i) => `SpellAttr${i}`)
      ]
    }

    for (const [file, names] of Object.entries(headerNames)) {
      const destination = path.join(dir, root, file)

      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(
        destination,
        names
          .map((name) =>
            name === 'Powers'
              ? 'enum Powers { POWER_MANA = 0, POWER_HEALTH = 0xFFFFFFFE, POWER_SENTINEL = 0xFFFFFFFF };'
              : `enum ${name} { ${name.toUpperCase()}_NONE = 0, ${name.toUpperCase()}_FIRST = 1, ${name.toUpperCase()}_SECOND = 2 };`
          )
          .join('\n')
      )
    }

    importSpellEnums(database, path.join(dir, root))

    const output = new DatabaseSync(database)

    expect(
      output
        .prepare("SELECT value, name FROM enum_value WHERE enum_name = 'reference.dbc_Category.ID'")
        .all()
    ).toEqual([{ name: 'Example category', value: 4 }])
    expect(
      output.prepare('SELECT Effect_1, Effect_2, Effect_3, Category FROM dbc_Spell').get()
    ).toMatchObject({ Category: 4, Effect_1: 1, Effect_2: 2, Effect_3: 9999 })
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
    unpackPackage(dir)

    const client = new Client({ name: 'test-spell', version: '1' })

    await client.connect(packagedServer(dir, database))

    try {
      const get = JSON.stringify(
        await client.callTool({ arguments: { ids: ['spell:1', 'spell:755'] }, name: 'get' })
      )

      for (const expected of [
        'Effect_1: 1 (FIRST)',
        'Effect_2: 2 (SECOND)',
        'Effect_3: 9999',
        'EffectAura_3: 1 (FIRST)',
        'EffectAura_1: 1 (FIRST)',
        'EffectAura_2: 2 (SECOND)',
        'ImplicitTargetA_2: 2 (SECOND)',
        'ImplicitTargetA_1: 1 (FIRST)',
        'ImplicitTargetA_3: 1 (FIRST)',
        'ImplicitTargetB_1: 1 (FIRST)',
        'ImplicitTargetB_2: 2 (SECOND)',
        'ImplicitTargetB_3: 1 (FIRST)',
        'Targets: 1 (FIRST)',
        'TargetCreatureType: 2 (SECOND)',
        'InterruptFlags: 1 (FIRST)',
        'AuraInterruptFlags: 2 (SECOND)',
        'ChannelInterruptFlags: 1 (FIRST)',
        'SchoolMask: 1 (FIRST)',
        'ProcTypeMask: 2 (SECOND)',
        'Attributes: 9 (FIRST, 8)',
        'AttributesExG: 2 (SECOND)',
        'PowerType: -1',
        'PowerType: -2 (HEALTH)',
        'Category: 4 (Example category)',
        'Missing: 7'
      ]) {
        expect(get).toContain(expected)
      }
      expect(get).not.toContain('PowerType: -1 (')

      const sql = JSON.stringify(
        await client.callTool({
          arguments: {
            query: 'SELECT Effect_1, Effect_2, Effect_3, Attributes, Category FROM dbc_Spell'
          },
          name: 'sql'
        })
      )

      expect(sql).toContain('1\\t2\\t9999\\t9\\t4')
    } finally {
      const achievement = await client.callTool({
        arguments: { ids: ['achievement:7'] },
        name: 'get'
      })

      expect(JSON.stringify(achievement)).toContain('Supercedes: 6 (Level 10)')
      await client.close()
    }

    const invalid = new DatabaseSync(database)

    invalid.exec('ALTER TABLE dbc_Spell DROP COLUMN Effect_3')

    const values = invalid.prepare('SELECT * FROM enum_value ORDER BY enum_name, value').all()
    const fields = invalid.prepare('SELECT * FROM enum_field ORDER BY source_table, field').all()

    invalid.close()
    expect(() => {
      importSpellEnums(database, path.join(dir, root))
    }).toThrow('Missing mapped column dbc_Spell.Effect_3')

    const unchanged = new DatabaseSync(database, { readOnly: true })

    expect(unchanged.prepare('SELECT * FROM enum_value ORDER BY enum_name, value').all()).toEqual(
      values
    )
    expect(
      unchanged.prepare('SELECT * FROM enum_field ORDER BY source_table, field').all()
    ).toEqual(fields)
    unchanged.close()

    const restored = new DatabaseSync(database)

    restored.exec('ALTER TABLE dbc_Spell ADD COLUMN Effect_3 INTEGER')
    restored.close()

    const shared = path.join(dir, root, 'src/server/shared/SharedDefines.h')

    writeFileSync(
      shared,
      readFileSync(shared, 'utf8').replace('enum SpellEffects', 'enum RemovedSpellEffects')
    )
    expect(() => {
      importSpellEnums(database, path.join(dir, root))
    }).toThrow('Missing pinned enum SpellEffects')

    const afterMissingEnum = new DatabaseSync(database, { readOnly: true })

    expect(
      afterMissingEnum.prepare('SELECT * FROM enum_value ORDER BY enum_name, value').all()
    ).toEqual(values)
    expect(
      afterMissingEnum.prepare('SELECT * FROM enum_field ORDER BY source_table, field').all()
    ).toEqual(fields)
    afterMissingEnum.close()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
