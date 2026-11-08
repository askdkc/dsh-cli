import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyKiokukoBinding } from './verify-kiokuko-binding.mjs'

test('optional local binding rejects copied identities without rewriting files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kiokuko-binding-'))
  try {
    assert.match(verifyKiokukoBinding(root), /^SKIP:/)
    const instructions = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n- Repository ID: `repo_current`\n- Workspace: `project:current`\n<!-- END KIOKUKO MANAGED BLOCK -->\n'
    writeFileSync(join(root, 'AGENTS.md'), instructions)
    const writeBinding = value => writeFileSync(join(root, '.kiokuko.json'), JSON.stringify(value))
    writeBinding({ repositoryId: 'repo_old', workspace: 'project:old' })
    assert.throws(() => verifyKiokukoBinding(root), /repositoryId mismatch/)
    writeBinding({ repositoryId: 'repo_current', workspace: 'project:old' })
    assert.throws(() => verifyKiokukoBinding(root), /workspace mismatch/)
    writeBinding({ repositoryId: 'repo_current', workspace: 'project:current' })
    assert.match(verifyKiokukoBinding(root), /^PASS:/)
    writeFileSync(join(root, '.kiokuko.json'), '{')
    assert.throws(() => verifyKiokukoBinding(root), SyntaxError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('version 1 pointer reads only the delegated managed identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kiokuko-pointer-'))
  try {
    writeFileSync(join(root, '.kiokuko.json'), JSON.stringify({ repositoryId: 'repo_current', workspace: 'project:current' }))
    writeFileSync(join(root, 'AGENTS.md'), '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-instructions-pointer: 1 -->\n<!-- END KIOKUKO MANAGED BLOCK -->\n')
    assert.throws(() => verifyKiokukoBinding(root), /\.kiokuko\/AGENTS\.md/)
    mkdirSync(join(root, '.kiokuko'))
    const delegated = join(root, '.kiokuko', 'AGENTS.md')
    const body = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n- Repository ID: `repo_current`\n- Workspace: `project:current`\n<!-- END KIOKUKO MANAGED BLOCK -->\n'
    writeFileSync(delegated, body)
    assert.match(verifyKiokukoBinding(root), /^PASS:/)
    writeFileSync(delegated, body.replace('repo_current', 'repo_copied'))
    assert.throws(() => verifyKiokukoBinding(root), /repositoryId mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
