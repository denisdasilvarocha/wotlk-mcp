import { initReference } from '../../build/offsets.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

function createFixture(dir: string): { database: string; runner: string } {
  const database = path.join(dir, 'reference.sqlite')
  const runner = path.join(dir, 'runner.ts')

  mkdirSync(path.join(dir, 'data/sql/custom'), { recursive: true })
  mkdirSync(path.join(dir, 'modules'))
  initReference(database)
  writeFileSync(
    path.join(dir, 'docker'),
    `#!/bin/sh
case "$*" in
  "rm -fv "*|"network rm "*) echo "$*" >> "$WORLD_STATE/removals" ;;
  *"SELECT VERSION()"*) printf '8.4.3\\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\\t+00:00\\tutf8mb4\\tutf8mb4_general_ci\\n' ;;
  *information_schema.columns*) cat data/world/schema-columns.tsv ;;
  *information_schema.statistics*) cat data/world/schema-indexes.tsv ;;
  *"SELECT COUNT("*) echo 0 ;;
  *"ORDER BY SHA2("*)
    if [ -f "$WORLD_STATE/scanned" ]; then
      kill -TERM "$PPID"
      exec sleep 5
    fi
    touch "$WORLD_STATE/scanned" ;;
esac
`,
    { mode: 0o755 }
  )
  writeFileSync(
    runner,
    `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { importWorld } from ${JSON.stringify(path.resolve('build/world/index.ts'))}

if (process.env.WORLD_MODE === 'spawn') {
  const spawn = childProcess.spawn
  let scans = 0
  childProcess.spawn = (command, args, options) => {
    if (command === 'docker' && args.at(-1)?.includes('ORDER BY SHA2(') && ++scans === 2) {
      command = ${JSON.stringify(path.join(dir, 'missing-docker'))}
    }
    return spawn(command, args, options)
  }
  syncBuiltinESMExports()
}
try {
  await importWorld(${JSON.stringify(database)}, { directory: ${JSON.stringify(dir)}, archive: 'unused', revision: '${'a'.repeat(40)}', sha256: '${'b'.repeat(64)}' }, 'acore/importer@sha256:${'c'.repeat(64)}', ${JSON.stringify(path.join(dir, 'work'))})
} catch (error) {
  console.error('Caught World import failure:', error)
  process.exitCode ||= 1
}
`
  )
  return { database, runner }
}

test.skipIf(process.platform === 'win32').each([
  { code: 1, error: /Caught World import failure: Error: spawn .* ENOENT/u, mode: 'spawn' },
  { code: 143, error: /Caught World import failure: AbortError/u, mode: 'interruption' }
])('World scan $mode failure rolls back and cleans up', ({ code, error, mode }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-scan-'))

  try {
    const { database, runner } = createFixture(dir)
    const env = {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      WORLD_MODE: mode,
      WORLD_STATE: dir
    }

    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', runner], {
      encoding: 'utf8',
      env,
      timeout: 20_000
    })

    expect(result.stderr).toMatch(error)
    expect(result.status).toBe(code)
    const removals = readFileSync(path.join(dir, 'removals'), 'utf8')

    expect(removals.match(/^rm -fv /gmu)).toHaveLength(2)
    expect(removals).toMatch(/^network rm /mu)
    using db = new DatabaseSync(database, { readOnly: true })
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'world_*'").all()

    expect(tables).toEqual([])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
