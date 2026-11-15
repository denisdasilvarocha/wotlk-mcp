import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

const catalog = 'data/offsets'
const command = 'scripts/validate-offsets.ts'

function validate(directory: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--experimental-strip-types', command, directory], {
    encoding: 'utf8'
  })
}

describe('Offsets catalog', () => {
  it('preserves every original declaration, note and classification', () => {
    const entries = []
    const namespaces: string[] = []
    const original = readFileSync('tests/fixtures/original-offsets.txt', 'utf8')

    for (const line of original.split('\n')) {
      const namespace = /^\s*namespace (\w+) \{/.exec(line)
      const declaration = /^\s*constexpr uint32_t (\w+) = (0x[0-9A-F]{8}); \/\/ (.*)$/.exec(line)

      if (namespace) namespaces.push(namespace[1])
      else if (/^\s*}/.test(line)) namespaces.pop()
      else if (declaration) {
        let kind = 'function'
        const [, name, va, note] = declaration
        const path = [...namespaces.slice(1), name].join('::')

        if (path.startsWith('Globals::') || path.startsWith('Cache::ClientDbPointer::'))
          kind = 'data'

        let status

        if (/not present/i.test(note)) status = 'not-present'
        else if (/unverified/i.test(note)) status = 'unverified'

        const record = { path, va, kind, note }

        if (status) entries.push({ ...record, status })
        else entries.push(record)
      }
    }

    const files = readdirSync(catalog).filter((file) => file.endsWith('.json'))
    const actual = files.flatMap((file) =>
      JSON.parse(readFileSync(nodePath.join(catalog, file), 'utf8'))
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
      const entry = { path: 'Lua::Example', va: '0x00819210', kind: 'function', note: 'example' }

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
        JSON.stringify([{ ...entry, path: 'Lua::Other', kind: 'field' }])
      )
      expect(validate(directory).status).not.toBe(0)
      writeFileSync(
        nodePath.join(directory, 'two.json'),
        JSON.stringify([{ ...entry, path: 'Lua::Other', status: 'verified' }])
      )
      expect(validate(directory).status).not.toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
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
