import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 console.log('same-checkout API absence and forbidden local fallback OK')
}finally{rmSync(temp,{recursive:true,force:true})}
