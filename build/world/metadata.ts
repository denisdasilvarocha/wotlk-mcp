import type { StatementSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'
import type { SourceArchive } from '../sources/index.ts'

function populateWorldRecords(db: Database): void {
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
}

export function populateWorldMetadata(
  db: Database,
  metadata: Readonly<StatementSync>,
  source: Readonly<SourceArchive>,
  mysqlImage: string,
  importerImage: string
): void {
  const pins = db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()

  if (!pins || typeof pins.value !== 'string') {
    throw new Error('Reference input pins are missing')
  }

  metadata.run('input_pins', JSON.stringify({ ...JSON.parse(pins.value), world: source.revision }))
  metadata.run('world.mysql_image', mysqlImage)
  metadata.run('world.importer_image', importerImage)
  db.prepare(
    'INSERT INTO source (name, pin, sha256, licence, attribution) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'world',
    source.revision,
    source.sha256,
    'GPL-2.0-or-later; data may have additional rights; see data/world/azerothcore-LICENSE.txt',
    `AzerothCore authors; see data/world/azerothcore-AUTHORS.txt. Modified by conversion to SQLite. Corresponding source: https://github.com/azerothcore/azerothcore-wotlk/tree/${source.revision}`
  )
  populateWorldRecords(db)
}
