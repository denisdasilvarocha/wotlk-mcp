import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { addLink } from './links.ts'

const [, , file] = process.argv
if (!file || process.argv.length !== 3 || !existsSync(file))
  throw new Error('Usage: vpx scripts/build-world-links.ts EXISTING_REFERENCE.sqlite')

const db = new DatabaseSync(file)
db.exec('PRAGMA foreign_keys = ON; BEGIN')
try {
  function addRows(query: string, relation: string): void {
    for (const row of db.prepare(query).iterate())
      addLink(db, String(row.source), relation, String(row.destination), String(row.note))
  }
  for (const kind of ['creature', 'gameobject'])
    for (const [suffix, relation] of [
      ['starter', 'starts'],
      ['ender', 'ends']
    ]) {
      const table = `world_${kind}_quest${suffix}`
      addRows(
        `SELECT '${kind}:' || e.id AS source, 'quest:' || e.quest AS destination,
        '${table}' AS note FROM ${table} e
        JOIN record s ON s.id = '${kind}:' || e.id
        JOIN record d ON d.id = 'quest:' || e.quest`,
        relation
      )
    }
  for (const [column, amount] of [
    ...Array.from({ length: 4 }, (_, i) => [`RewardItem${i + 1}`, `RewardAmount${i + 1}`]),
    ...Array.from({ length: 6 }, (_, i) => [
      `RewardChoiceItemID${i + 1}`,
      `RewardChoiceItemQuantity${i + 1}`
    ])
  ])
    addRows(
      `SELECT 'quest:' || q.ID AS source, 'item:' || q.${column} AS destination,
      '${column} quantity=' || q.${amount} AS note FROM world_quest_template q
      JOIN record s ON s.id = 'quest:' || q.ID
      JOIN record d ON d.id = 'item:' || q.${column} WHERE q.${column} > 0`,
      'rewards'
    )
  for (const column of ['RewardSpell', 'RewardDisplaySpell'])
    addRows(
      `SELECT 'quest:' || q.ID AS source, 'spell:' || q.${column} AS destination,
      '${column}' AS note FROM world_quest_template q
      JOIN record s ON s.id = 'quest:' || q.ID
      JOIN record d ON d.id = 'spell:' || q.${column} WHERE q.${column} > 0`,
      'rewards'
    )
  addRows(
    `SELECT 'creature:' || v.entry AS source, 'item:' || v.item AS destination,
    'slot=' || v.slot || ', maxcount=' || v.maxcount || ', incrtime=' || v.incrtime || ', ExtendedCost=' || v.ExtendedCost AS note
    FROM world_npc_vendor v JOIN record s ON s.id = 'creature:' || v.entry
    JOIN record d ON d.id = 'item:' || v.item WHERE v.item > 0`,
    'sells'
  )
  addRows(
    `SELECT 'creature:' || t.CreatureId AS source, 'spell:' || p.SpellId AS destination,
    'TrainerId=' || t.TrainerId || ', cost=' || p.MoneyCost || ', skill=' || p.ReqSkillLine ||
    ', rank=' || p.ReqSkillRank || ', level=' || p.ReqLevel AS note
    FROM world_creature_default_trainer t JOIN world_trainer_spell p ON p.TrainerId = t.TrainerId
    JOIN record s ON s.id = 'creature:' || t.CreatureId
    JOIN record d ON d.id = 'spell:' || p.SpellId WHERE p.SpellId > 0`,
    'teaches'
  )
  for (let slot = 1; slot <= 5; slot++)
    addRows(
      `SELECT 'item:' || i.entry AS source, 'spell:' || i.spellid_${slot} AS destination,
      'spellid_${slot}, trigger=' || i.spelltrigger_${slot} AS note FROM world_item_template i
      JOIN record s ON s.id = 'item:' || i.entry
      JOIN record d ON d.id = 'spell:' || i.spellid_${slot} WHERE i.spellid_${slot} > 0`,
      'casts'
    )
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
} finally {
  db.close()
}
