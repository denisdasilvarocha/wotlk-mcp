import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { addLink } from './links.ts'

const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const [file] = args
if (!file || args.length !== 1)
  throw new Error('Usage: build-client-faction-spawn-links <reference.sqlite>')
if (!existsSync(file)) throw new Error(`Reference database not found: ${file}`)
const db = new DatabaseSync(file)
try {
  db.exec('PRAGMA foreign_keys = ON; BEGIN')
  try {
    db.exec(
      "DELETE FROM link WHERE relation IN ('contains', 'grants', 'belongs to', 'faction', 'spawns in')"
    )
    function addRows(
      query: string,
      relation: string,
      note?: (row: Record<string, unknown>) => string
    ): void {
      for (const row of db.prepare(query).iterate())
        addLink(db, String(row.source), relation, String(row.destination), note?.(row) ?? '')
    }
    function arrays(
      table: string,
      prefix: string,
      count: number,
      from: string,
      to: string,
      relation: string
    ): void {
      for (let i = 1; i <= count; i++)
        addRows(
          `SELECT '${from}:' || t.ID AS source, '${to}:' || t.${prefix}_${i} AS destination
          FROM ${table} t JOIN record s ON s.id = '${from}:' || t.ID
          JOIN record d ON d.id = '${to}:' || t.${prefix}_${i}
          WHERE t.${prefix}_${i} > 0`,
          relation,
          () => `${prefix}_${i}`
        )
    }
    arrays('dbc_ItemSet', 'ItemID', 17, 'itemset', 'item', 'contains')
    arrays('dbc_Talent', 'SpellRank', 9, 'talent', 'spell', 'grants')
    addRows(
      `SELECT 'spell:' || a.Spell AS source, 'skillline:' || a.SkillLine AS destination,
      a.ID AS evidence FROM dbc_SkillLineAbility a
      JOIN record s ON s.id = 'spell:' || a.Spell
      JOIN record d ON d.id = 'skillline:' || a.SkillLine`,
      'belongs to',
      (r) => `SkillLineAbility ${String(r.evidence)}`
    )
    addRows(
      `SELECT 'creature:' || c.entry AS source, 'faction:' || f.Faction AS destination,
      f.ID AS evidence FROM world_creature_template c JOIN dbc_FactionTemplate f ON f.ID = c.faction
      JOIN record s ON s.id = 'creature:' || c.entry
      JOIN record d ON d.id = 'faction:' || f.Faction`,
      'faction',
      (r) => `FactionTemplate ${String(r.evidence)}`
    )
    for (const kind of ['creature', 'gameobject']) {
      let variants = ''
      if (kind === 'creature')
        variants =
          ' UNION SELECT c.guid, v.entry AS id, c.map FROM world_creature c JOIN world_creature_multispawn v ON v.spawnId = c.guid'
      addRows(
        `SELECT '${kind}:' || spawn.id AS source, 'map:' || spawn.map AS destination,
        COUNT(*) AS count FROM (SELECT guid, id, map FROM world_${kind}${variants}) spawn
        JOIN record s ON s.id = '${kind}:' || spawn.id
        JOIN record d ON d.id = 'map:' || spawn.map
        GROUP BY spawn.id, spawn.map`,
        'spawns in',
        (r) => `${String(r.count)} stored spawn rows`
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
} finally {
  db.close()
}
