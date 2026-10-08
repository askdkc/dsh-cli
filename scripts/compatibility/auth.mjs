import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { adapterBuiltinProviders } = await import('../../dsh-auth/lib/pi-ai.js')
const { buildOAuthProfile, CATALOG_PROVIDER_IDS } = await import('../../dsh-auth/lib/profiles.js')
const authRequire = createRequire(new URL('../../dsh-auth/lib/pi-ai.js', import.meta.url))
const require = createRequire(authRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
const root = require.resolve.paths('@earendil-works/pi-ai').find(root => existsSync(join(root,'@earendil-works/pi-ai/dist/providers/all.js')))
assert(root)
const url = pathToFileURL(realpathSync(join(root,'@earendil-works/pi-ai/dist/providers/all.js'))).href
const catalog = await import(url)
assert.equal(adapterBuiltinProviders, catalog.builtinProviders)
for (const id of CATALOG_PROVIDER_IDS) {
 if (id === 'opencode' || id === 'opencode-go') {
  assert.throws(() => buildOAuthProfile(id), /native adapter/)
  continue
 }
 const profile = buildOAuthProfile(id)
 assert.equal(profile.piProvider.id, id)
 assert.equal(typeof profile.piProvider.getModels, 'function')
 const models = profile.piProvider.getModels()
 assert(models.length > 0, id)
 for(const model of models) assert.equal(typeof model.id, 'string')
 assert(profile.piProvider.auth)
}
console.log('host-owned pi module and every catalog route OK', url)
