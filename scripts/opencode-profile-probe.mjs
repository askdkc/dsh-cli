import assert from 'node:assert/strict'
import {writeFile,mkdir,readFile,realpath} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {attributionHeaders} from '@deepseek-ai/dsh-llm'
import {loadProfile,composeEntries,loadLayeredEnv} from '@deepseek-ai/dsh-app-boot'
import {runProfile} from './node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
let fixtureFetch
if(process.env.DSH_AUTH_TEST_PHASE!=='baseline') {
  await mkdir(new URL('./dsh-auth/', 'file://'+process.env.DSH_HOME+'/'),{recursive:true})
  await writeFile(process.env.DSH_AUTH_CREDENTIALS,JSON.stringify({version:1,providers:{opencode:{type:'api_key',key:'fixture-key'},'opencode-go':{type:'api_key',key:'fixture-key'}}}))
  fixtureFetch=async (url,init)=> {
    if(String(url).includes('models.dev')) return Response.json({opencode:{models:{}},'opencode-go':{models:{}}})
    if(String(url).endsWith('/models')) return Response.json({data:[{id:String(url).includes('/go/')?'gpt-6-luna':'claude-sonnet-5-5'}]})
    const headers=new Headers(init.headers);assert.equal(String(url).endsWith('/messages')?headers.get('x-api-key'):headers.get('authorization'),String(url).endsWith('/messages')?'fixture-key':'Bearer fixture-key');assert.equal(headers.get('x-opencode-session'),'fixture-session');assert(headers.get('user-agent')?.includes(attributionHeaders()['user-agent']))
    const body=JSON.parse(init.body)
    if(String(url).endsWith('/messages')) {assert.equal(body.output_config.effort,'high');assert.equal(body.thinking,undefined)}
    else {assert.equal(body.reasoning.effort,'high');assert.equal(body.store,false)}
    let events
    if(String(url).endsWith('/messages')) events=[
      {type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[],usage:{input_tokens:1,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'installed'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
      {type:'message_stop'}]
    else {assert(String(url).endsWith('/responses'));events=[
      {type:'response.created',response:{id:'resp_fixture',model:'gpt-6-luna',created_at:1}},
      {type:'response.output_item.added',output_index:0,item:{type:'message',id:'msg_fixture',role:'assistant',content:[]}},
      {type:'response.output_text.delta',item_id:'msg_fixture',output_index:0,content_index:0,delta:'installed'},
      {type:'response.output_item.done',output_index:0,item:{type:'message',id:'msg_fixture',role:'assistant',content:[{type:'output_text',text:'installed',annotations:[]}]}},
      {type:'response.completed',response:{id:'resp_fixture',model:'gpt-6-luna',status:'completed',usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}]}
    return new Response(events.map(event=>(String(url).endsWith('/messages')?'event: '+event.type+'\n':'')+'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
  }
}
if(process.env.DSH_AUTH_TEST_PHASE!=='independent') {
  const hostRequire=createRequire(import.meta.url)
  const adapterRequire=createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'))
  // pi exposes only ESM entry points and does not export its manifest.
  // Read the first installed dependency manifest in this disposable host.
  let pi
  for(const root of adapterRequire.resolve.paths('@earendil-works/pi-ai')??[]) {
    try {pi=JSON.parse(await readFile(join(root,'@earendil-works/pi-ai/package.json'),'utf8'));break}
    catch(error) {if(error.code!=='ENOENT') throw error}
  }
  assert(pi?.version, 'host pi manifest must resolve')
  if(process.env.DSH_AUTH_TEST_PI) assert.equal(pi.version,process.env.DSH_AUTH_TEST_PI)
  console.log('host-owned pi', pi.version)
}
const profile=loadProfile('probe','dsh-cli',new URL('./node_modules/@deepseek-ai/dsh/package.json',import.meta.url).pathname,process.env.DSH_HOME)
const kept=new Set(['llm','commands','dsh-cli-auth'])
const overlay=new URL('./probe-'+process.env.DSH_AUTH_TEST_PHASE+'.yml',import.meta.url).pathname
const patches=composeEntries(profile.layers.map(layer=>layer.patches)).map(entry=>({id:entry.id,disabled:!kept.has(entry.id)}))
if(process.env.DSH_AUTH_TEST_PHASE==='independent') patches.find(entry=>entry.id==='dsh-cli-auth').config={providers:['opencode','opencode-go']}
await writeFile(overlay,JSON.stringify(patches))
const timeout=setTimeout(()=>{console.error('profile boot timeout');process.exit(2)},30000)
try {
if(fixtureFetch) globalThis.fetch=fixtureFetch
const app=await runProfile({profile:'dsh-cli',environment:loadLayeredEnv('probe'),args:[],patchFiles:[overlay]})
const api=app.ctx.get('dshAuth')?.api
if(process.env.DSH_AUTH_TEST_PHASE==='baseline') {
  if(process.env.DSH_AUTH_TEST_PI==='0.87.1') assert.equal(api,undefined)
  else assert(api)
} else {
  assert(api);const llm=app.ctx.get('llm');const models=[['opencode','claude-sonnet-5-5'],['opencode-go','gpt-6-luna']]
  for(const [provider,id] of models) {
    assert.equal((await llm.resolveModelInfo(provider,id)).id,id)
    const chunks=[];for await(const chunk of llm.stream({provider,model:id,sessionId:'fixture-session',reasoningEffort:'high',messages:[{role:'user',content:[{type:'text',text:'test'}]}]})) chunks.push(chunk)
    assert(chunks.some(chunk=>chunk.type==='text-delta'&&chunk.text==='installed'), JSON.stringify(chunks));assert.equal(chunks.at(-1).reason.kind,'stop')
  }
  const providers=await api.providers()
  const authRoot=join(process.env.DSH_HOME,'profiles/dsh-cli/node_modules/@askdkc/dsh-cli/node_modules/@askdkc/dsh-auth')
  const {AUTH_PROVIDER_IDS}=await import(pathToFileURL(join(authRoot,'lib/routes.js')).href)
  const expectedProviders=process.env.DSH_AUTH_TEST_PHASE==='independent'?['opencode','opencode-go']:[...AUTH_PROVIDER_IDS]
  assert.deepEqual(providers.map(row=>row.provider).sort(),expectedProviders.sort())
  for(const provider of providers) {
    assert.equal(typeof provider.label,'string')
    assert(provider.authMethods.length>0,provider.provider)
  }
  if(process.env.DSH_AUTH_TEST_PHASE==='updated') {
    const carrier=join(process.env.DSH_HOME,'profiles/dsh-cli/node_modules/@askdkc/dsh-cli')
    const installed=JSON.parse(await readFile(join(carrier,'package.json'),'utf8'))
    const {installedCliVersion}=await import(pathToFileURL(join(carrier,'lib/types/package-version.js')).href)
    assert.equal(installedCliVersion(),installed.version,'actual tarball metadata must match its own manifest')
    const authModule=join(authRoot,'lib/pi-ai.js')
    const {adapterBuiltinProviders}=await import(pathToFileURL(authModule).href)
    const authRequire=createRequire(authModule)
    const adapterRequire=createRequire(authRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
    let catalogPath
    for(const root of adapterRequire.resolve.paths('@earendil-works/pi-ai')??[]) {
      try {catalogPath=await realpath(join(root,'@earendil-works/pi-ai/dist/providers/all.js'));break}
      catch(error) {if(error.code!=='ENOENT') throw error}
    }
    assert(catalogPath,'installed adapter catalog must resolve')
    const {builtinProviders}=await import(pathToFileURL(catalogPath).href)
    assert.equal(adapterBuiltinProviders,builtinProviders,'auth and its adapter must use one pi module')
    const manifest=JSON.parse(await readFile(join(dirname(catalogPath),'../../package.json'),'utf8'))
    if(process.env.DSH_AUTH_TEST_PI) assert.equal(manifest.version,process.env.DSH_AUTH_TEST_PI,'comparison must exercise the installed auth adapter too')
    const {buildOAuthProfile,CATALOG_PROVIDER_IDS}=await import(pathToFileURL(join(authRoot,'lib/profiles.js')).href)
    for(const id of CATALOG_PROVIDER_IDS.filter(id=>!id.startsWith('opencode'))) {
      const native=builtinProviders().find(provider=>provider.id===id)
      assert(native,id)
      const profile=buildOAuthProfile(id)
      assert.deepEqual(Object.keys(profile.piProvider.auth),Object.keys(native.auth))
      if(native.auth.oauth) {
        for(const method of ['login','refresh','getApiKey']) assert.equal(typeof profile.piProvider.auth.oauth[method],typeof native.auth.oauth[method])
      }
      assert.deepEqual(profile.piProvider.getModels(),native.getModels())
      const model=native.getModels()[0]
      assert(model,id)
      assert.equal((await llm.resolveModelInfo(id,model.id)).id,model.id)
    }
    console.log(`installed auth pi=${manifest.version} catalog=${catalogPath}; catalog models, auth interfaces and export identity OK`)
    await import(pathToFileURL(join(authRoot,'scripts/smoke.mjs')).href)
    await import(pathToFileURL(join(authRoot,'scripts/verify-provider-wire.mjs')).href)
  }
}
await app.shutdown.shutdown(0)
console.log('profile '+process.env.DSH_AUTH_TEST_PHASE+' ready')
} finally {clearTimeout(timeout)}
