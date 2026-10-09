#!/usr/bin/env node
/**
 * prepare 前置守卫：git tarball / 未递归克隆时 vendor 子模块不存在，
 * 编译必然全线 TS2307——与其让 prepare 深处爆栈，不如在这里快速失败
 * 并给出正确指引（装 registry 包，或递归克隆后自举）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const probe = join(process.cwd(), 'vendor', 'dsh-std', 'packages', 'core', 'package.json')
if (!existsSync(probe)) {
  console.error('[prepare-guard] vendor/dsh-std submodule content is missing —')
  console.error('  this is a git tarball or a non-recursive clone, where `npm run compile`')
  console.error('  cannot succeed (every vendored import fails to resolve).')
  console.error('  - Installing as a plugin? Use the registry package instead:')
  console.error('      dsh plugin --profile dsh-cli add @askdkc/dsh-cli')
  console.error('  - Building from source? Clone recursively, then re-run:')
  console.error('      git clone --recurse-submodules https://github.com/askdkc/dsh-cli')
  process.exit(1)
}
