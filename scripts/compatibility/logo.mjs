import assert from 'node:assert/strict'
import fs, { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
const temp = mkdtempSync(join(tmpdir(),'compat-logo-'))
const originalRead = fs.readFileSync
let metadataReads = 0
fs.readFileSync = function(path, ...args) {
 if (String(path).startsWith(temp) && String(path).endsWith('package.json')) metadataReads++
 return originalRead.call(this, path, ...args)
}
syncBuiltinESMExports()
try {
 cpSync('lib',join(temp,'lib'),{recursive:true})
 writeFileSync(join(temp,'lib/types/package.json'),'{"type":"module"}')
 symlinkSync(join(process.cwd(),'node_modules'),join(temp,'node_modules'),'dir')
 for (const [name, metadata, expected] of [
  ['valid',{name:'@askdkc/dsh-cli',version:'1.2.3'},true],
  ['foreign',{name:'foreign',version:'9.9.9'},false],
  ['invalid',{name:'@askdkc/dsh-cli',version:'bad'},false],
  ['missing',undefined,false],
  ['broken','{',false],
 ]) {
  const manifest=join(temp,'package.json')
  if(metadata===undefined) rmSync(manifest)
  else writeFileSync(manifest,typeof metadata==='string'?metadata:JSON.stringify({...metadata,type:'module'}))
  const {LogoV2} = await import(pathToFileURL(join(temp,'lib/types/components/LogoV2.js')).href+'?'+name)
  const {renderToScreen,scanPositions} = await import(pathToFileURL(join(temp,'lib/types/ink/render-to-screen.js')).href)
  const {TerminalSizeContext} = await import(pathToFileURL(join(temp,'lib/types/ink/components/TerminalSizeContext.js')).href)
  const props={model:'fixture',cwd:'.',whale:false,skipIntro:true,whaleIdle:false}
  const element=React.createElement(TerminalSizeContext.Provider,{value:{columns:100,rows:30}},React.createElement(LogoV2,props))
  const readsBeforeRender=metadataReads
  const rendered=renderToScreen(element,100)
  renderToScreen(element,100)
  assert.equal(metadataReads,readsBeforeRender,'render and rerender must not reread metadata')
  assert.equal(scanPositions(rendered.screen,'v1.2.3').length>0,expected)
  assert.equal(scanPositions(rendered.screen,'v9.9.9').length,0)
  assert.equal(scanPositions(rendered.screen,'v0.1.0').length,0)
  assert.equal(scanPositions(rendered.screen,'vbad').length,0)
 }
 console.log('actual logo metadata omission and version display OK')
} finally {
 fs.readFileSync=originalRead
 syncBuiltinESMExports()
 rmSync(temp,{recursive:true,force:true})
}
