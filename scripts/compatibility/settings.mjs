import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { editableConfig, resolveSettingsNamespace } from '../../src/dsh-adapter/compat/settings.ts'

test('reject missing volatile before any schema replacement', () => {
  for (const volatile of [undefined, 1]) {
    const schema = Schema.object({ a: Schema.boolean(), b: Schema.boolean() })
    const before = { ...schema.dict }
    schema.dict.b.volatile = volatile
    assert.throws(() => editableConfig(schema, ['a', 'b']), /volatile Config support/)
    assert.deepEqual(schema.dict, before)
  }
})
test('a throwing later conversion leaves the schema unchanged', () => {
  const schema = Schema.object({ a: Schema.boolean(), b: Schema.boolean().volatile() })
  const before = { ...schema.dict }
  assert.throws(() => editableConfig(schema, ['a', 'b']), /already wrapped/)
  assert.deepEqual(schema.dict, before)
  const duplicate = Schema.object({ a: Schema.boolean() })
  const original = duplicate.dict.a
  assert.throws(() => editableConfig(duplicate, ['a', 'a']), /already wrapped/)
  assert.equal(duplicate.dict.a, original)
})
test('valid conversion, empty and unknown keys, Loader owner', () => {
  const schema = Schema.object({ a: Schema.boolean() })
  assert.equal(editableConfig(schema, []), schema)
  assert.equal(editableConfig(schema, ['missing']), schema)
  editableConfig(schema, ['a'])
  assert.equal(schema.dict.a.meta.volatile, true)
  assert.throws(() => resolveSettingsNamespace({ fiber: {} }, schema), /Loader entry/)
  assert.throws(() => resolveSettingsNamespace({}, schema), /Loader entry/)
  assert.throws(() => resolveSettingsNamespace({ fiber: { entry: {} } }, schema), /Loader entry/)
  assert.equal(resolveSettingsNamespace({ fiber: { entry: { options: { id: 'owner' } } } }, schema), 'owner')
})
