export const kinds = [
  'spell',
  'talent',
  'itemset',
  'skillline',
  'map',
  'area',
  'faction',
  'class',
  'race',
  'achievement',
  'creature',
  'item',
  'quest',
  'gameobject',
  'fn',
  'event',
  'widget',
  'method',
  'cvar',
  'type',
  'cle',
  'template',
  'slash',
  'offset',
  'file'
]
export const relations = [
  ['drops', 'dropped by'],
  ['starts', 'started by'],
  ['ends', 'ended by'],
  ['rewards', 'rewarded by'],
  ['sells', 'sold by'],
  ['teaches', 'taught by'],
  ['casts', 'cast by'],
  ['contains', 'contained in'],
  ['grants', 'granted by'],
  ['belongs to', 'includes'],
  ['faction', 'faction of'],
  ['spawns in', 'spawns'],
  ['implemented by', 'implements']
]
export const schema = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source (name TEXT PRIMARY KEY, pin TEXT NOT NULL, sha256 TEXT NOT NULL, licence TEXT NOT NULL, attribution TEXT NOT NULL);
CREATE TABLE record (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, source_table TEXT NOT NULL, source_row INTEGER NOT NULL, search_text TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '');
CREATE INDEX record_name ON record(name COLLATE NOCASE);
CREATE INDEX record_kind ON record(kind);
CREATE TABLE link (source_id TEXT NOT NULL REFERENCES record(id), relation TEXT NOT NULL, destination_id TEXT NOT NULL REFERENCES record(id), notes TEXT NOT NULL DEFAULT '', PRIMARY KEY(source_id, relation, destination_id));
CREATE INDEX link_destination ON link(destination_id);
CREATE VIRTUAL TABLE record_fts USING fts5(id UNINDEXED, name, text, tokenize='trigram');
CREATE VIRTUAL TABLE ui_line_fts USING fts5(path UNINDEXED, line UNINDEXED, text, tokenize='trigram');
CREATE TABLE enum_value (enum_name TEXT NOT NULL, value INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(enum_name, value, name));
CREATE TABLE enum_field (source_table TEXT NOT NULL, field TEXT NOT NULL, enum_name TEXT NOT NULL, flags INTEGER NOT NULL DEFAULT 0, condition_field TEXT, condition_value INTEGER, PRIMARY KEY(source_table, field, enum_name, condition_value));
CREATE TABLE offsets_entry (path TEXT PRIMARY KEY, va TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, status TEXT);
`
