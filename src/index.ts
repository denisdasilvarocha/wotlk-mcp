#!/usr/bin/env node

import { terminateSqlWorkers } from './sql.js'

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)

if (major < 24 || (major === 24 && minor < 15)) {
  console.error(`wotlk-mcp needs Node ≥ 24.15 (node:sqlite); found v${process.versions.node}`)
  process.exit(1)
}

process.once('exit', terminateSqlWorkers)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

await import('./server.js')
