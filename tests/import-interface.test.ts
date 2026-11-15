import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vite-plus/test'

import { importInterface } from '../build/interface.ts'
import { schema } from '../src/schema.ts'

function hash(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

test('maintainer import preserves source, command evidence and atomic hash verification', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'interface-import-'))

  try {
    const source =
      'SLASH_CAST1 = "/cast";\r\nSLASH_CAST2 = "/spell";\r\nSecureCmdList["CAST"] = function() end\r\nEMOTE102_CMD1 = "/wave";\r\n--SlashCmdList["CAST"] = function() end\r\n'
    const xml = '<Ui>literal source text</Ui>\n'
    const files = [
      { path: 'Interface/FrameXML/GlobalStrings.lua', content: source },
      { path: 'Interface/AddOns/Blizzard_Test/Test.xml', content: xml },
      { path: 'Interface/Other/ignored.lua', content: 'ignored' }
    ]

    for (const file of files) {
      const name = path.join(dir, file.path)

      mkdirSync(path.dirname(name), { recursive: true })
      writeFileSync(name, file.content)
    }

    const manifest = JSON.stringify({
      format: 1,
      client: {
        build: 12340,
        locale: 'enGB',
        original_executable_sha256:
          'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
      },
      files: files.map((file) => ({
        path: file.path,
        archive: 'enGB/patch-enGB-3.MPQ',
        sha256: hash(file.content)
      }))
    })

    writeFileSync(path.join(dir, 'manifest.json'), manifest)

    const database = path.join(dir, 'reference.sqlite')
    const db = new DatabaseSync(database)

    db.exec(schema)
    db.close()
    expect(() => importInterface(database, dir, '0'.repeat(64))).toThrow(
      'Client manifest SHA-256 mismatch'
    )

    const failed = new DatabaseSync(database)

    expect(
      failed.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_file'").get()
    ).toMatchObject({ n: 0 })
    failed.close()
    writeFileSync(path.join(dir, files[0].path), 'tampered')
    expect(() => importInterface(database, dir, hash(manifest))).toThrow(
      'Interface SHA-256 mismatch'
    )

    const corrupted = new DatabaseSync(database)

    expect(
      corrupted.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ui_file'").get()
    ).toMatchObject({ n: 0 })
    corrupted.close()
    writeFileSync(path.join(dir, files[0].path), source)
    importInterface(database, dir, hash(manifest))

    const result = new DatabaseSync(database, { readOnly: true })

    expect(
      result.prepare('SELECT path, manifest_path, locale FROM ui_file ORDER BY path').all()
    ).toEqual([
      {
        path: 'AddOns/Blizzard_Test/Test.xml',
        manifest_path: 'Interface/AddOns/Blizzard_Test/Test.xml',
        locale: 'enGB'
      },
      {
        path: 'FrameXML/GlobalStrings.lua',
        manifest_path: 'Interface/FrameXML/GlobalStrings.lua',
        locale: 'enGB'
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
    ).toMatchObject([{ path: 'AddOns/Blizzard_Test/Test.xml', line: 1 }])

    const cast = result.prepare('SELECT * FROM ui_slash WHERE command = ?').get('CAST')

    if (!cast || typeof cast.aliases !== 'string' || typeof cast.handlers !== 'string')
      throw new Error('Missing CAST command evidence')

    expect(cast.secure).toBe(1)
    expect(JSON.parse(cast.aliases)).toMatchObject([
      { line: 1, value: '/cast' },
      { line: 2, value: '/spell' }
    ])
    expect(JSON.parse(cast.handlers)).toEqual([
      { path: 'FrameXML/GlobalStrings.lua', line: 3, registry: 'SecureCmdList' }
    ])
    expect(
      result.prepare('SELECT emote FROM ui_slash WHERE command = ?').get('EMOTE102')
    ).toMatchObject({ emote: 1 })
    expect(
      result
        .prepare('SELECT id FROM record WHERE id IN (?, ?) ORDER BY id')
        .all('slash:CAST', 'file:FrameXML/GlobalStrings.lua')
    ).toHaveLength(2)
    expect(
      result
        .prepare("SELECT id, name, text FROM record_fts WHERE substr(id,1,5) = 'file:' ORDER BY id")
        .all()
    ).toEqual([
      { id: 'file:AddOns/Blizzard_Test/Test.xml', name: 'AddOns/Blizzard_Test/Test.xml', text: '' },
      { id: 'file:FrameXML/GlobalStrings.lua', name: 'FrameXML/GlobalStrings.lua', text: '' }
    ])
    expect(
      result.prepare('SELECT attribution FROM source WHERE name = ?').get('interface')?.attribution
    ).toContain('enUS byte identity is not verified')
    result.close()
    expect(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(manifest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
