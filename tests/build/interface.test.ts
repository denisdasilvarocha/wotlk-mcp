import { importInterface } from '../../build/interface/index.ts'
import { schema } from '../../src/schema.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

const source =
  'SLASH_CAST1 = "/cast";\r\nSLASH_CAST2 = "/spell";\r\nSecureCmdList["CAST"] = function() end\r\nEMOTE102_CMD1 = "/wave";\r\n--SlashCmdList["CAST"] = function() end\r\n'
const xml = '<Ui>literal source text</Ui>\n'
const files = [
  { content: source, path: 'Interface/FrameXML/GlobalStrings.lua' },
  { content: xml, path: 'Interface/AddOns/Blizzard_Test/Test.xml' },
  { content: 'ignored', path: 'Interface/Other/ignored.lua' }
] as const

interface Fixture {
  readonly dir: string
  readonly manifest: string
  readonly database: string
}

interface SlashEvidence {
  readonly aliases: string
  readonly handlers: string
  readonly secure: number
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function createFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'interface-import-'))

  for (const file of files) {
    const name = path.join(dir, file.path)

    mkdirSync(path.dirname(name), { recursive: true })
    writeFileSync(name, file.content)
  }

  const manifest = JSON.stringify({
    client: {
      build: 12340,
      locale: 'enGB',
      original_executable_sha256: 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
    },
    files: files.map((file) => ({
      archive: 'enGB/patch-enGB-3.MPQ',
      path: file.path,
      sha256: hash(file.content)
    })),
    format: 1
  })

  writeFileSync(path.join(dir, 'manifest.json'), manifest)

  const database = path.join(dir, 'reference.sqlite')
  const db = new DatabaseSync(database)

  db.exec(schema)
  db.close()

  return { database, dir, manifest }
}

function readSlashEvidence(
  row: Readonly<Record<string, unknown>> | undefined
): Readonly<SlashEvidence> {
  if (
    !row ||
    typeof row.aliases !== 'string' ||
    typeof row.handlers !== 'string' ||
    typeof row.secure !== 'number'
  ) {
    throw new Error('Missing CAST command evidence')
  }

  return { aliases: row.aliases, handlers: row.handlers, secure: row.secure }
}

test('maintainer import verifies manifest and interface hashes atomically', () => {
  const { dir, manifest, database } = createFixture()

  try {
    expect(() => {
      importInterface(database, dir, '0'.repeat(64))
    }).toThrow('Client manifest SHA-256 mismatch')

    const failed = new DatabaseSync(database)

    expect(
      failed.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_file'").get()
    ).toMatchObject({ n: 0 })
    failed.close()
    writeFileSync(path.join(dir, files[0].path), 'tampered')
    expect(() => {
      importInterface(database, dir, hash(manifest))
    }).toThrow('Interface SHA-256 mismatch')

    const corrupted = new DatabaseSync(database)

    expect(
      corrupted.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_file'").get()
    ).toMatchObject({ n: 0 })
    corrupted.close()
    writeFileSync(path.join(dir, files[0].path), source)
    importInterface(database, dir, hash(manifest))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('maintainer import preserves interface files, lines and full-text search', () => {
  const { dir, manifest, database } = createFixture()

  try {
    importInterface(database, dir, hash(manifest))
    const result = new DatabaseSync(database, { readOnly: true })

    expect(
      result.prepare('SELECT path, manifest_path, locale FROM ui_file ORDER BY path').all()
    ).toEqual([
      {
        locale: 'enGB',
        manifest_path: 'Interface/AddOns/Blizzard_Test/Test.xml',
        path: 'AddOns/Blizzard_Test/Test.xml'
      },
      {
        locale: 'enGB',
        manifest_path: 'Interface/FrameXML/GlobalStrings.lua',
        path: 'FrameXML/GlobalStrings.lua'
      }
    ])
    expect(
      result
        .prepare('SELECT line, text FROM ui_line WHERE path = ? ORDER BY line')
        .all('FrameXML/GlobalStrings.lua')
    ).toEqual([
      { line: 1, text: 'SLASH_CAST1 = "/cast";' },
      { line: 2, text: 'SLASH_CAST2 = "/spell";' },
      { line: 3, text: 'SecureCmdList["CAST"] = function() end' },
      { line: 4, text: 'EMOTE102_CMD1 = "/wave";' },
      { line: 5, text: '--SlashCmdList["CAST"] = function() end' }
    ])
    expect(
      result
        .prepare('SELECT path, line FROM ui_line_fts WHERE ui_line_fts MATCH ?')
        .all('"literal"')
    ).toMatchObject([{ line: 1, path: 'AddOns/Blizzard_Test/Test.xml' }])
    expect(
      result
        .prepare("SELECT id, name, text FROM record_fts WHERE substr(id,1,5) = 'file:' ORDER BY id")
        .all()
    ).toEqual([
      { id: 'file:AddOns/Blizzard_Test/Test.xml', name: 'AddOns/Blizzard_Test/Test.xml', text: '' },
      { id: 'file:FrameXML/GlobalStrings.lua', name: 'FrameXML/GlobalStrings.lua', text: '' }
    ])
    result.close()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('maintainer import records slash command evidence', () => {
  const { dir, manifest, database } = createFixture()

  try {
    importInterface(database, dir, hash(manifest))

    const result = new DatabaseSync(database, { readOnly: true })
    const cast = readSlashEvidence(
      result.prepare('SELECT * FROM ui_slash WHERE command = ?').get('CAST')
    )

    expect(cast.secure).toBe(1)
    expect(JSON.parse(cast.aliases)).toMatchObject([
      { line: 1, value: '/cast' },
      { line: 2, value: '/spell' }
    ])
    expect(JSON.parse(cast.handlers)).toEqual([
      { line: 3, path: 'FrameXML/GlobalStrings.lua', registry: 'SecureCmdList' }
    ])
    expect(
      result.prepare('SELECT emote FROM ui_slash WHERE command = ?').get('EMOTE102')
    ).toMatchObject({ emote: 1 })
    expect(
      result
        .prepare('SELECT id FROM record WHERE id IN (?, ?) ORDER BY id')
        .all('slash:CAST', 'file:FrameXML/GlobalStrings.lua')
    ).toHaveLength(2)
    result.close()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('maintainer import records interface attribution without rewriting the manifest', () => {
  const { dir, manifest, database } = createFixture()

  try {
    importInterface(database, dir, hash(manifest))

    const result = new DatabaseSync(database, { readOnly: true })

    expect(
      result.prepare('SELECT attribution FROM source WHERE name = ?').get('interface')?.attribution
    ).toContain('enUS byte identity is not verified')
    result.close()
    expect(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(manifest)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
