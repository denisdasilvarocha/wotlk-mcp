import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

const root = path.resolve('world')

function run(mode: string): {
  status: number | null
  output: string
  report: boolean
  container: boolean
  network: boolean
} {
  const temp = mkdtempSync(path.join(tmpdir(), 'world-command-'))
  const bin = path.join(temp, 'bin')
  const out = path.join(temp, 'output')
  mkdirSync(bin)
  const executables: Record<string, string> = {
    openssl: `case "$*" in
      *dbimport-build.patch*) echo f6b3c5c896d67271b53fc5c98896d12d2f188ead9e66007da6d2ed067a5d2eb9 ;;
      *) echo 748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9 ;;
    esac`,
    tar: 'mkdir -p "$4/data/sql/custom" "$4/modules"',
    patch: 'cat >/dev/null',
    docker: `case "$*" in
      'network create '*) touch "$WORLD_TEST_STATE/network" ;;
      'network rm '*) rm -f "$WORLD_TEST_STATE/network" ;;
      'rm -f '*) rm -f "$WORLD_TEST_STATE/container" ;;
      'run -d '*) touch "$WORLD_TEST_STATE/container" ;;
      *'SELECT 1'*) exit 0 ;;
      *'/build/src/tools/dbimport'*) [ "$WORLD_TEST_MODE" != updater ] || exit 42 ;;
      *--skip-column-names*)
        sql=$(cat)
        case "$sql" in *information_schema.columns*) part=columns ;; *) part=indexes ;; esac
        cat "$WORLD_TEST_ROOT/schema-$part.tsv"
        [ "$WORLD_TEST_MODE" != schema ] || echo drift
        ;;
    esac`
  }
  for (const [name, body] of Object.entries(executables))
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  writeFileSync(path.join(temp, 'source.tar.gz'), '')
  const result = spawnSync(
    'sh',
    [path.join(root, 'reproduce.sh'), path.join(temp, 'source.tar.gz'), out],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        WORLD_TEST_MODE: mode,
        WORLD_TEST_STATE: temp,
        WORLD_TEST_ROOT: root
      }
    }
  )
  const report = existsSync(path.join(out, 'report.txt'))
  const container = existsSync(path.join(temp, 'container'))
  const network = existsSync(path.join(temp, 'network'))
  rmSync(temp, { recursive: true, force: true })
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    report,
    container,
    network
  }
}

test('updater failure does not produce a success report', () => {
  const result = run('updater')
  expect(result.status).toBe(42)
  expect(result.container).toBe(false)
  expect(result.network).toBe(false)
  expect(result.report).toBe(false)
})

test('schema drift fails before producing a success report', () => {
  const result = run('schema')
  expect(result.status).not.toBe(0)
  expect(result.output).toContain('schema columns drifted')
  expect(result.report).toBe(false)
  expect(result.container).toBe(false)
  expect(result.network).toBe(false)
})

test('standalone World Data reproduction keeps its container and network on success', () => {
  const result = run('success')
  expect(result.status).toBe(0)
  expect(result.report).toBe(true)
  expect(result.container).toBe(true)
  expect(result.network).toBe(true)
})
