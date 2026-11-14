import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vite-plus/test'

import { initReference } from '../build/offsets.ts'

function fixture(mode: string): { dir: string; runner: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-import-'))
  const bin = path.join(dir, 'bin')
  const source = path.join(dir, 'source')
  const database = path.join(dir, 'reference.sqlite')
  mkdirSync(bin)
  mkdirSync(path.join(source, 'data/sql/custom'), { recursive: true })
  mkdirSync(path.join(source, 'modules'), { recursive: true })
  initReference(database)
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh
echo "$*" >> "$WORLD_STATE/commands"
case "$*" in
  "network create "*) touch "$WORLD_STATE/network" ;;
  "network rm "*) rm -f "$WORLD_STATE/network" ;;
  "rm -fv "*)
    case "$WORLD_MODE:$*" in cleanup:*mysql*) exit 7 ;; esac
    rm -f "$WORLD_STATE/$(echo "$*" | awk '{print $3}')" ;;
  "run -d "*) name=""; while [ "$#" -gt 0 ]; do if [ "$1" = "--name" ]; then name="$2"; break; fi; shift; done; touch "$WORLD_STATE/$name" ;;
  "run "*)
    name=""; while [ "$#" -gt 0 ]; do if [ "$1" = "--name" ]; then name="$2"; break; fi; shift; done
    touch "$WORLD_STATE/$name"
    case "$WORLD_MODE" in updater|cleanup) echo updater-failure >&2; exit 42 ;; signal) touch "$WORLD_STATE/waiting"; exec sleep 60 ;; esac ;;
  *"SELECT 1"*) exit 0 ;;
  *"--skip-column-names"*)
    case "$*" in
      *"SELECT VERSION()"*) printf '8.4.3\\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\\t+00:00\\tutf8mb4\\tutf8mb4_general_ci\\n' ;;
      *information_schema.columns*) if [ "$WORLD_MODE" = export ]; then cat data/world/schema-columns.tsv; else echo drift; fi ;;
      *information_schema.statistics*) cat data/world/schema-indexes.tsv ;;
      *"SELECT COUNT("*) echo export-failure >&2; exit 43 ;;
      *) echo drift ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  )
  const runner = path.join(dir, 'runner.ts')
  writeFileSync(
    runner,
    `import { importWorld } from ${JSON.stringify(path.resolve('build/world.ts'))}
try { await importWorld(${JSON.stringify(database)}, { directory: ${JSON.stringify(source)}, archive: 'unused', revision: '${'a'.repeat(40)}', sha256: '${'b'.repeat(64)}' }, 'acore/importer@sha256:${'c'.repeat(64)}', ${JSON.stringify(path.join(dir, 'work'))}) }
catch (error) { console.error(error); process.exitCode ||= 1 }
`
  )
  return {
    dir,
    runner,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      WORLD_STATE: dir,
      WORLD_MODE: mode
    }
  }
}

const failures = [
  { mode: 'updater', message: 'updater-failure' },
  { mode: 'schema', message: 'schema columns drifted' },
  { mode: 'export', message: 'export-failure' }
]
for (const { mode, message } of failures)
  test(`World ${mode} failure attempts resource cleanup and reports failure`, () => {
    const f = fixture(mode)
    try {
      const result = spawnSync(process.execPath, [f.runner], { encoding: 'utf8', env: f.env })
      expect(result.status).not.toBe(0)
      expect(result.stderr + result.stdout).toContain(message)
      const commands = readFileSync(path.join(f.dir, 'commands'), 'utf8')
      expect(commands.match(/^rm -fv /gm)).toHaveLength(2)
      expect(commands).toMatch(/^network rm /m)
      expect(existsSync(path.join(f.dir, 'network'))).toBe(false)
      expect(commands).toContain('AC_SOURCE_DIRECTORY=/source')
      expect(commands).toContain('AC_UPDATES_ALLOWED_MODULES=')
      expect(commands).toContain('mysql -h127.0.0.1')
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

test('cleanup failure preserves the original error and attempts every removal', () => {
  const f = fixture('cleanup')
  try {
    const result = spawnSync(process.execPath, [f.runner], { encoding: 'utf8', env: f.env })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('World resource cleanup failed')
    expect(result.stderr.lastIndexOf('updater-failure')).toBeGreaterThan(
      result.stderr.indexOf('World resource cleanup failed')
    )
    const commands = readFileSync(path.join(f.dir, 'commands'), 'utf8')
    const removals = commands
      .split('\n')
      .filter((line) => line.startsWith('rm -fv ') || line.startsWith('network rm '))
    expect(removals).toHaveLength(3)
    expect(removals[0]).toMatch(/-importer$/)
    expect(removals[1]).toMatch(/-mysql$/)
    expect(removals[2]).toMatch(/^network rm /)
    expect(existsSync(path.join(f.dir, removals[1].split(' ')[2]))).toBe(true)
    expect(existsSync(path.join(f.dir, 'network'))).toBe(false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('custom SQL is rejected before Docker resources are created', () => {
  const f = fixture('updater')
  try {
    writeFileSync(path.join(f.dir, 'source/data/sql/custom/extra.sql'), 'SELECT 1;')
    const result = spawnSync(process.execPath, [f.runner], { encoding: 'utf8', env: f.env })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('custom or module SQL is not allowed')
    expect(existsSync(path.join(f.dir, 'commands'))).toBe(false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

const signals: { signal: NodeJS.Signals; code: number }[] = [
  { signal: 'SIGINT', code: 130 },
  { signal: 'SIGTERM', code: 143 }
]
test.each(signals)(
  '$signal cleans containers and network before exit',
  async ({ signal, code }) => {
    const f = fixture('signal')
    try {
      const child = spawn(process.execPath, [f.runner], { env: f.env, stdio: 'ignore' })
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
      for (
        let i = 0;
        i < 200 &&
        !existsSync(path.join(f.dir, 'waiting')) &&
        child.exitCode === null &&
        child.signalCode === null;
        i++
      )
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50))

      expect(existsSync(path.join(f.dir, 'waiting'))).toBe(true)
      child.kill(signal)
      const status = await exited
      expect(status).toBe(code)
      const commands = readFileSync(path.join(f.dir, 'commands'), 'utf8')
      expect(commands.match(/^rm -fv /gm)).toHaveLength(2)
      expect(commands).toMatch(/^network rm /m)
      expect(existsSync(path.join(f.dir, 'network'))).toBe(false)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  }
)
