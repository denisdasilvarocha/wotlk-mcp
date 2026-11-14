import type { DatabaseSync } from 'node:sqlite'

export function indexWorld(db: DatabaseSync): void {
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
