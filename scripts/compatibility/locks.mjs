import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
// These are the packages whose required closure changes when the host replaces pi.
const owned = key => /^(@earendil-works\/pi-(ai|telemetry)|openai)@/.test(key)
// The diff audit is for the current uncommitted change. CI always checks the
// host-owned default without imposing this change's scope on later updates.
const compareWorkingTree = process.argv.includes('--compare-working-tree')
for (const file of ['pnpm-lock.yaml', 'dsh-auth/pnpm-lock.yaml']) {
 const after = parse(readFileSync(file,'utf8'))
 assert.equal(after.overrides?.['@earendil-works/pi-ai'],undefined)
 if(!compareWorkingTree) {console.log(file,'host-owned pi default OK');continue}
 const before = parse(execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}))
 const stable = lock => Object.fromEntries(Object.entries(lock.packages).filter(([key])=>!owned(key)))
 assert.deepEqual(stable(after),stable(before),`${file}: unrelated package resolution changed`)
 const piPeers = lock => new Set(Object.entries(lock.snapshots).filter(([key])=>key.startsWith('@earendil-works/pi-ai@')).flatMap(([,value])=>value.transitivePeerDependencies??[]))
 const beforePeers=piPeers(before),afterPeers=piPeers(after)
 const changedPeers=new Set([...beforePeers,...afterPeers].filter(peer=>beforePeers.has(peer)!==afterPeers.has(peer)))
 const hostPeer = (name,version) => {
  if(name!=='@deepseek-ai/dsh-llm-pi-ai') return version
  let normalized=version.replace(/\([a-f0-9]{32}\)$/, '(host-pi)')
  for(const peer of changedPeers) {
   const escaped=peer.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
   normalized=normalized.replace(new RegExp('\\('+escaped+'@[^()]+\\)','g'),'')
  }
  return normalized
 }
 const snapshots = lock => Object.fromEntries(Object.entries(lock.snapshots).filter(([key])=>!owned(key)).map(([key,value])=>{
  const snapshot=structuredClone(value)
  const name=key.slice(0,key.indexOf('@',1))
  if(name==='@deepseek-ai/dsh-llm-pi-ai') {
   delete snapshot.dependencies?.['@earendil-works/pi-ai']
   snapshot.transitivePeerDependencies=snapshot.transitivePeerDependencies?.filter(peer=>!changedPeers.has(peer))
  }
  for(const section of ['dependencies','optionalDependencies']) {
   for(const [name,version] of Object.entries(snapshot[section]??{})) snapshot[section][name]=hostPeer(name,version)
  }
  return [hostPeer(name,key),snapshot]
 }))
 assert.deepEqual(snapshots(after),snapshots(before),`${file}: unrelated dependency edges or peers changed`)
 for (const [importer, sections] of Object.entries(before.importers)) {
  for (const section of ['dependencies','devDependencies','optionalDependencies']) {
   for (const [name, dependency] of Object.entries(sections[section]??{})) {
    const current=after.importers[importer][section][name]
    assert.equal(current.specifier,dependency.specifier)
    assert.equal(hostPeer(name,current.version),hostPeer(name,dependency.version),name)
   }
  }
 }
 console.log(file,'unrelated dependencies unchanged; host pi closure only')
}
if(compareWorkingTree) assert.equal(readFileSync('standalone/pnpm-lock.yaml','utf8'),execFileSync('git',['show','HEAD:standalone/pnpm-lock.yaml'],{encoding:'utf8'}))
