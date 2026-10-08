import ts from 'typescript'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
export function assertCheckoutResolution(program, options, sourceRoot) {
 sourceRoot = realpathSync(sourceRoot)
 for (const file of program.getSourceFiles()) {
  for (const entry of file.imports ?? []) {
   if (!/^@deepseek-ai\/(?:dsh-|cordis(?:-|$)|schemastery(?:$|\/)|cosmokit(?:$|\/))/.test(entry.text)) continue
   const resolved = ts.resolveModuleName(entry.text, file.fileName, options, ts.sys).resolvedModule
   const path = resolved && realpathSync(resolved.resolvedFileName)
   if (!path || !path.startsWith(sourceRoot + sep) || path.slice(sourceRoot.length).split(sep).includes('node_modules')) throw new Error(`upstream resolution escaped checkout (required mapping or source missing): ${entry.text} from ${file.fileName}; resolved=${resolved?.resolvedFileName ?? 'unresolved'}`)
  }
 }
}
