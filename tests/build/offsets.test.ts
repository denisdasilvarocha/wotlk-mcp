import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vite-plus/test'

const catalog = 'data/offsets'
const command = 'scripts/validate-offsets.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()
}

type OffsetEntry = {
  readonly kind: string
  readonly note: string
  readonly path: string
  readonly va: string
  readonly status?: string
}

function validate(directory: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--experimental-strip-types', command, directory], {
    encoding: 'utf8'
  })
}

function hasPath(entry: unknown): entry is Readonly<{ path: string }> {
  return (
    typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string'
  )
}

function parseEntries(json: string): readonly Readonly<{ path: string }>[] {
  const parsed: unknown = JSON.parse(json)

  if (!Array.isArray(parsed)) {
    throw new TypeError('Expected offset entries')
  }

  return parsed.map((entry: unknown) => {
    if (!hasPath(entry)) {
      throw new TypeError('Invalid offset entry')
    }

    return entry
  })
}

function originalEntries(original: string): OffsetEntry[] {
  const entries: OffsetEntry[] = []
  const namespaces: string[] = []

  for (const line of original.split('\n')) {
    const namespace = /^\s*namespace (\w+) \{/u.exec(line)
    const declaration = /^\s*constexpr uint32_t (\w+) = (0x[0-9A-F]{8}); \/\/ (.*)$/u.exec(line)

    if (namespace) {
      namespaces.push(namespace[1])
    } else if (/^\s*\}/u.test(line)) {
      namespaces.pop()
    } else if (declaration) {
      let kind = 'function'
      const [, name, va, note] = declaration
      const path = [...namespaces.slice(1), name].join('::')

      if (path.startsWith('Globals::') || path.startsWith('Cache::ClientDbPointer::')) {
        kind = 'data'
      }

      let status

      if (/not present/iu.test(note)) {
        status = 'not-present'
      } else if (/unverified/iu.test(note)) {
        status = 'unverified'
      }

      const record = { kind, note, path, va }

      if (status !== undefined && status !== '') {
        entries.push({ ...record, status })
      } else {
        entries.push(record)
      }
    }
  }

  return entries
}

describe('Offset import', () => {
  it('stores and hashes committed topics even when the index and worktree differ', () => {
    const directory = mkdtempSync(nodePath.join(tmpdir(), 'offset-snapshot-'))

    try {
      const topics = nodePath.join(directory, catalog)
      const tracked = nodePath.join(topics, 'topic.json')
      const entry = { kind: 'function', note: 'committed', path: 'Lua::Example', va: '0x00819210' }
      const committed = `${JSON.stringify([entry])}\n`
      const database = nodePath.join(directory, 'reference.sqlite')
      const moduleUrl = new URL('../../build/offsets.ts', import.meta.url).href
      git(directory, 'init', '--template=')
      mkdirSync(topics, { recursive: true })
      writeFileSync(nodePath.join(directory, '.gitignore'), '/data/offsets/ignored.json\n')
      writeFileSync(tracked, committed)
      git(directory, 'add', '-f', '.gitignore', `${catalog}/topic.json`)
      git(
        directory,
        '-c',
        'user.name=Offsets Test',
        '-c',
        'user.email=offsets@example.test',
        'commit',
        '-m',
        'Fixture'
      )
      const pin = git(directory, 'rev-parse', 'HEAD')
      writeFileSync(tracked, JSON.stringify([{ ...entry, note: 'staged' }]))
      git(directory, 'add', `${catalog}/topic.json`)
      writeFileSync(tracked, JSON.stringify([{ ...entry, note: 'unstaged' }]))
      writeFileSync(
        nodePath.join(topics, 'untracked.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Untracked' }])
      )
      writeFileSync(
        nodePath.join(topics, 'ignored.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Ignored' }])
      )

      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `import { initReference } from ${JSON.stringify(moduleUrl)}; initReference(process.argv[1])`,
          database
        ],
        { cwd: directory }
      )

      using db = new DatabaseSync(database, { readOnly: true })
      expect(db.prepare('SELECT path, va, kind, note FROM offsets_entry').all()).toEqual([entry])
      expect(db.prepare("SELECT pin, sha256 FROM source WHERE name = 'offsets'").get()).toEqual({
        pin,
        sha256: createHash('sha256').update(`topic.json\0${committed}`).digest('hex')
      })
      expect(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()).toEqual({
        value: JSON.stringify({ offsets: pin })
      })
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

describe('Offsets catalog', () => {
  it('preserves every original declaration, note and classification', () => {
    const entries = originalEntries(readFileSync('tests/fixtures/original-offsets.txt', 'utf8'))

    const files = readdirSync(catalog).filter((file) => file.endsWith('.json'))
    const actual = files.flatMap((file) =>
      parseEntries(readFileSync(nodePath.join(catalog, file), 'utf8'))
    )

    expect(entries).toHaveLength(787)
    expect(actual.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
      entries.toSorted((a, b) => a.path.localeCompare(b.path))
    )
    expect(validate(catalog).status).toBe(0)
  })

  it('rejects malformed entries and duplicate paths while allowing shared VAs', () => {
    const directory = mkdtempSync(nodePath.join(tmpdir(), 'offsets-'))

    try {
      const entry = { kind: 'function', note: 'example', path: 'Lua::Example', va: '0x00819210' }

      writeFileSync(nodePath.join(directory, 'one.json'), JSON.stringify([entry]))
      writeFileSync(
        nodePath.join(directory, 'two.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Other' }])
      )
      expect(validate(directory).status).toBe(0)
      writeFileSync(nodePath.join(directory, 'two.json'), JSON.stringify([entry]))
      expect(validate(directory).status).not.toBe(0)
      writeFileSync(
        nodePath.join(directory, 'two.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Other', va: '0x0081921a' }])
      )
      expect(validate(directory).status).not.toBe(0)
      writeFileSync(
        nodePath.join(directory, 'two.json'),
        JSON.stringify([{ ...entry, kind: 'field', path: 'Lua::Other' }])
      )
      expect(validate(directory).status).not.toBe(0)
      writeFileSync(
        nodePath.join(directory, 'two.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Other', status: 'verified' }])
      )
      expect(validate(directory).status).not.toBe(0)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('keeps the editor schema generated from the validation schema', () => {
    const generated = execFileSync(
      process.execPath,
      ['--experimental-strip-types', command, '--schema'],
      { encoding: 'utf8' }
    )

    expect(JSON.parse(readFileSync('data/offsets.schema.json', 'utf8'))).toEqual(
      JSON.parse(generated)
    )
  })
})
