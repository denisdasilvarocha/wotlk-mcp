import { addLinkRows } from './insert.ts'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'

function addArrays(
  db: Database,
  table: string,
  prefix: string,
  count: number,
  from: string,
  to: string,
  relation: string
): void {
  for (let i = 1; i <= count; i++) {
    addLinkRows(
      db,
      `SELECT '${from}:' || t.ID AS source, '${to}:' || t.${prefix}_${i} AS destination,
          '${prefix}_${i}' AS note FROM ${table} t JOIN record s ON s.id = '${from}:' || t.ID
          JOIN record d ON d.id = '${to}:' || t.${prefix}_${i}
          WHERE t.${prefix}_${i} > 0`,
      relation
    )
  }
}

function addClientLinks(db: Database): void {
  addArrays(db, 'dbc_ItemSet', 'ItemID', 17, 'itemset', 'item', 'contains')
  addArrays(db, 'dbc_Talent', 'SpellRank', 9, 'talent', 'spell', 'grants')
  addLinkRows(
    db,
    `SELECT 'spell:' || a.Spell AS source, 'skillline:' || a.SkillLine AS destination,
      'SkillLineAbility ' || COALESCE(a.ID, 'null') AS note FROM dbc_SkillLineAbility a
      JOIN record s ON s.id = 'spell:' || a.Spell
      JOIN record d ON d.id = 'skillline:' || a.SkillLine`,
    'belongs to'
  )
  addLinkRows(
    db,
    `SELECT 'creature:' || c.entry AS source, 'faction:' || f.Faction AS destination,
      'FactionTemplate ' || COALESCE(f.ID, 'null') AS note FROM world_creature_template c JOIN dbc_FactionTemplate f ON f.ID = c.faction
      JOIN record s ON s.id = 'creature:' || c.entry
      JOIN record d ON d.id = 'faction:' || f.Faction`,
    'faction'
  )
  for (const kind of ['creature', 'gameobject']) {
    let variants = ''
    if (kind === 'creature') {
      variants =
        ' UNION SELECT c.guid, v.entry AS id, c.map FROM world_creature c JOIN world_creature_multispawn v ON v.spawnId = c.guid'
    }
    addLinkRows(
      db,
      `SELECT '${kind}:' || spawn.id AS source, 'map:' || spawn.map AS destination,
        COUNT(*) || ' stored spawn rows' AS note FROM (SELECT guid, id, map FROM world_${kind}${variants}) spawn
        JOIN record s ON s.id = '${kind}:' || spawn.id
        JOIN record d ON d.id = 'map:' || spawn.map
        GROUP BY spawn.id, spawn.map`,
      'spawns in'
    )
  }
}

export function buildClientFactionSpawnLinks(file: string): void {
  if (!existsSync(file)) {
    throw new Error(`Reference database not found: ${file}`)
  }

  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN')

    try {
      db.exec(
        "DELETE FROM link WHERE relation IN ('contains', 'grants', 'belongs to', 'faction', 'spawns in')"
      )

      addClientLinks(db)

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}
