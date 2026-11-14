import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { expect, test } from 'vite-plus/test'

const root = resolve('world')

function run(mode: string): { status: number | null; output: string; report: boolean } {
  const temp = mkdtempSync(join(tmpdir(), 'world-command-'))
  const bin = join(temp, 'bin')
  const out = join(temp, 'output')
  mkdirSync(bin)
  const executables: Record<string, string> = {
    openssl: `case "$*" in
      *dbimport-build.patch*) echo f6b3c5c896d67271b53fc5c98896d12d2f188ead9e66007da6d2ed067a5d2eb9 ;;
      *) echo 748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9 ;;
    esac`,
    tar: 'mkdir -p "$4/data/sql/custom" "$4/modules"',
    patch: 'cat >/dev/null',
    docker: `case "$*" in
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
  for (const [name, body] of Object.entries(executables)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  writeFileSync(join(temp, 'source.tar.gz'), '')
  const result = spawnSync('sh', [join(root, 'reproduce.sh'), join(temp, 'source.tar.gz'), out], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      WORLD_TEST_MODE: mode,
      WORLD_TEST_ROOT: root
    }
  })
  const report = existsSync(join(out, 'report.txt'))
  rmSync(temp, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr, report }
}

test('updater failure does not produce a success report', () => {
  const result = run('updater')
  expect(result.status).toBe(42)
  expect(result.report).toBe(false)
})

test('schema drift fails before producing a success report', () => {
  const result = run('schema')
  expect(result.status).not.toBe(0)
  expect(result.output).toContain('schema columns drifted')
  expect(result.report).toBe(false)
})
