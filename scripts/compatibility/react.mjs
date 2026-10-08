import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
const registrations = []
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: config => { registrations.push(config); return 1 }, onCommitFiberRoot() {}, onCommitFiberUnmount() {} }
const { default: React } = await import('react')
const { default: Ink } = await import('../../lib/types/ink/ink.js')
const { default: Text } = await import('../../lib/types/ink/components/Text.js')
const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24; stdout.isTTY = false
let output = ''; stdout.on('data', chunk => { output += chunk })
const stdin = new PassThrough(); stdin.isTTY = false
const ink = new Ink({ stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false })
ink.render(React.createElement(Text, null, 'mounted'))
await new Promise(resolve => setTimeout(resolve, 100))
ink.render(React.createElement(Text, null, 'updated'))
await new Promise(resolve => setTimeout(resolve, 100))
ink.unmount()
assert.match(output, /mounted/); assert.match(output, /updated/)
if (process.env.NODE_ENV === 'development') {
 assert.equal(registrations.length, 1)
 assert.equal(registrations[0].version, React.version)
 assert.equal(registrations[0].rendererPackageName, 'ink')
} else assert.equal(registrations.length, 0)
console.log('renderer lifecycle and DevTools metadata OK', process.env.NODE_ENV)
