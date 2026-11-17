import { importSpellEnums } from './enums/spell.ts'
import { importWorldEnums } from './enums/world.ts'
import { buildClientFactionSpawnLinks } from './links/client-faction-spawn.ts'
import { buildLootLinks } from './links/loot.ts'
import { buildWorldLinks } from './links/world.ts'

type Run = <T>(label: string, action: () => T | Promise<T>) => Promise<T>

export async function runLinkStages(
  run: Run,
  database: string,
  azerothcore: string
): Promise<void> {
  await run('world links', () => {
    buildWorldLinks(database)
  })
  await run('loot links', () => {
    buildLootLinks(database)
  })
  await run('client and spawn links', () => {
    buildClientFactionSpawnLinks(database)
  })
  await run('world enums', () => {
    importWorldEnums(database, azerothcore)
  })
  await run('spell enums and foreign keys', () => {
    importSpellEnums(database, azerothcore)
  })
}
