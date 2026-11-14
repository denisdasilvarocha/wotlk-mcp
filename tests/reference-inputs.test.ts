import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

const script = path.resolve('scripts/reference-inputs.ts')

function executable(dir: string, name: string, body: string): void {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`)
  chmodSync(file, 0o755)
}

function run(output: string, bin: string) {
  return spawnSync(process.execPath, [script, output], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  })
}

test('does not overwrite an existing input directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))
  try {
    const output = path.join(dir, 'inputs')
    mkdirSync(output)
    writeFileSync(path.join(output, 'keep'), 'existing')
    const result = run(output, dir)
    expect(result.status).not.toBe(0)
    expect(readFileSync(path.join(output, 'keep'), 'utf8')).toBe('existing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a corrupt private release before extraction and removes partial inputs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))
  try {
    const output = path.join(dir, 'inputs')
    executable(dir, 'gh', 'for last do :; done\nprintf corrupt > "$last/client-inputs-12340-engb-1.tar.gz"')
    executable(dir, 'tar', `echo extracted > '${dir}/extracted'; exit 1`)
    const result = run(output, dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('bundle SHA-256 mismatch')
    expect(existsSync(path.join(dir, 'extracted'))).toBe(false)
    expect(existsSync(output)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a corrupt definitions download before fetching world data or Codex', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reference-inputs-test-'))
  try {
    const output = path.join(dir, 'inputs')
    executable(dir, 'gh', 'for last do :; done\nprintf bundle > "$last/client-inputs-12340-engb-1.tar.gz"')
    executable(dir, 'python3', 'exit 0')
    executable(dir, 'tar', 'exit 0')
    executable(dir, 'curl', 'for last do :; done\nprintf corrupt > "$last"')
    executable(dir, 'git', `echo called > '${dir}/git-called'; exit 1`)
    const result = run(output, dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SHA-256 mismatch:')
    expect(result.stderr).toContain('wowdbdefs.tar.gz')
    expect(existsSync(path.join(dir, 'git-called'))).toBe(false)
    expect(existsSync(output)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
