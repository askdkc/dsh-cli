import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCheckoutResolution } from '../upstream-resolution.mjs'
const temp=mkdtempSync(join(tmpdir(),'compat-upstream-'))
const validDeclaration='declare const Schema: { boolean(): { volatile(): unknown } }; export default Schema;'
try {
 const source=join(temp,'source');mkdirSync(source)
 const local=join(temp,'node_modules/@deepseek-ai/schemastery');mkdirSync(local,{recursive:true})
 writeFileSync(join(local,'package.json'),JSON.stringify({types:'index.d.ts'}))
 writeFileSync(join(local,'index.d.ts'),validDeclaration)
 const consumer=join(temp,'consumer.ts');writeFileSync(consumer,"import Schema from '@deepseek-ai/schemastery'; Schema.boolean().volatile();")
 const options={noEmit:true,skipLibCheck:true,types:[],module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler}
 const old=ts.createProgram([consumer],options)
 assert.equal(ts.getPreEmitDiagnostics(old).length,0,'old local declaration would falsely pass')
 assert.throws(()=>assertCheckoutResolution(old,options,source),/escaped checkout/)
 const installed=join(source,'node_modules/@deepseek-ai/schemastery/index.d.ts')
 mkdirSync(join(source,'node_modules/@deepseek-ai/schemastery'),{recursive:true})
 writeFileSync(installed,validDeclaration)
 const installedOptions={...options,paths:{'@deepseek-ai/schemastery':[installed]}}
 assert.throws(()=>assertCheckoutResolution(ts.createProgram([consumer],installedOptions),installedOptions,source),/escaped checkout/,'isolated npm declarations are not checkout sources either')
 const missing=join(source,'index.d.ts');writeFileSync(missing,'declare const Schema: { boolean(): {} }; export default Schema;')
 const mapped={...options,paths:{'@deepseek-ai/schemastery':[missing]}}
 const current=ts.createProgram([consumer],mapped)
 assertCheckoutResolution(current,mapped,source)
 assert(ts.getPreEmitDiagnostics(current).some(d=>d.code===2339),'checkout API absence must fail despite valid installed API')
 const broken={...options,paths:{'@deepseek-ai/schemastery':[join(source,'absent.d.ts')]}}
 assert.throws(()=>assertCheckoutResolution(ts.createProgram([consumer],broken),broken,source),/escaped checkout/)
 // Current hosts no longer provide dsh-invariants. The published companion
 // must keep its older-host registration API without importing that package.
 const cordis=join(source,'cordis.d.ts');writeFileSync(cordis,`export interface Context {
   sessions: { list(): { snapshotEvents(): readonly import('./session').SessionEvent[] }[] };
   on(name: 'internal/dispatch', listener: (mode: unknown, eventName: string, args: unknown[]) => void, options: { global: boolean }): void;
 }`)
 const session=join(source,'session.d.ts');writeFileSync(session,'export interface Session {} export interface SessionEvent { type: string; data: unknown }')
 const companion=new URL('../../src/dsh-adapter/invariant.ts',import.meta.url)
 const activityCompanion=new URL('../../vendor/dsh-working-activity/src/invariant.ts',import.meta.url)
 const companionOptions={...options,target:ts.ScriptTarget.ES2024,strict:true,paths:{'@deepseek-ai/cordis':[cordis],'@deepseek-ai/dsh-session':[session]}}
 const companionProgram=ts.createProgram([companion,activityCompanion].map(url=>fileURLToPath(url)),companionOptions)
 assert(!companionProgram.getSourceFiles().some(file=>file.fileName.includes('/@deepseek-ai/dsh-invariants/')),'companion must not fall back to the retired npm registry types')
 assertCheckoutResolution(companionProgram,companionOptions,source)
 assert.deepEqual(ts.getPreEmitDiagnostics(companionProgram).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[],'companion must typecheck without the retired registry package')
 const companionJs=ts.transpileModule(readFileSync(companion,'utf8'),{compilerOptions:companionOptions}).outputText
 const {apply,inject}=await import(`data:text/javascript,${encodeURIComponent(companionJs)}`)
 const dispose=()=>{};let registrations=0
 assert.deepEqual(inject,['invariants'])
 assert.equal(await apply({invariants:{register(name,install){
   assert.equal(name,'@askdkc/dsh-cli');assert.equal(install(),undefined);registrations++;return dispose
 }}}),dispose)
 assert.equal(registrations,1,'older hosts retain exactly one package registration')
 const activityJs=ts.transpileModule(readFileSync(activityCompanion,'utf8'),{compilerOptions:companionOptions}).outputText
 const activity=await import(`data:text/javascript,${encodeURIComponent(activityJs)}`)
 const status={phase:'idle',line:'Ready',toolCount:0,turnElapsedMs:0,phaseStartedAt:0}
 let dispatch
 assert.equal(await activity.apply({invariants:{register(name,install){
   assert.equal(name,'dsh-working-activity');assert.deepEqual(install.inject,['sessions'])
   install({sessions:{list:()=>[{snapshotEvents:()=>[{type:'activity/status',data:status}]}]},on(_name,listener){dispatch=listener}},message=>{throw new Error(message)})
   return dispose
 }}}),dispose)
 assert.equal(typeof dispatch,'function','activity companion must retain live validation')
 assert.doesNotThrow(()=>dispatch(null,'session/event',[{}, {type:'activity/status',data:status}]))
 assert.throws(()=>dispatch(null,'session/event',[{}, {type:'activity/status',data:{...status,line:''}}]),/line must be a non-empty string/)
 console.log('same-checkout API absence and forbidden local fallback OK')
}finally{rmSync(temp,{recursive:true,force:true})}
