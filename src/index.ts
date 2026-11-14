#!/usr/bin/env node
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major < 24 || (major === 24 && minor < 15)) {
  console.error(`wotlk-mcp needs Node ≥ 24.15 (node:sqlite); found v${process.versions.node}`)
  process.exit(1)
}
await import('./server.js')
