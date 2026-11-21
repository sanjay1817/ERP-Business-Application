#!/usr/bin/env node
/**
 * Runs a command with ELECTRON_RUN_AS_NODE removed from the environment.
 * Some editor/agent shells set it, which makes Electron start as plain Node
 * (and `app` is undefined). Usage: node scripts/run-electron.cjs <cmd> [...args]
 */
const { spawn } = require('node:child_process')

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: run-electron <command> [...args]')
  process.exit(2)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(cmd, args, { env, stdio: 'inherit', shell: process.platform === 'win32' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
