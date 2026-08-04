import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { KEY, buildKeyRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'my-encryption-key', worker_group: 'default', algorithm: 'aes-256-cbc', kms: 'local', keyclass: 0 }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an unrecognized algorithm', async () => {
  const res = await validate(ctxOf([{ ...good, algorithm: 'des' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good key', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildKeyRecord uses keyId (not id) as the wire identity field', () => {
  const spec = buildKeyRecord(good, {})
  assert.equal(spec.error, null)
  assert.equal(spec.body?.keyId, 'my-encryption-key')
  assert.equal(spec.body?.id, undefined)
})

test('buildKeyRecord never includes plainKey or cipherKey', () => {
  const spec = buildKeyRecord({ ...good, plainKey: 'leaked', cipherKey: 'leaked' }, {})
  assert.equal(spec.body?.plainKey, undefined)
  assert.equal(spec.body?.cipherKey, undefined)
})

test('KEY uses keyId as its identity field, no sensitive keys', () => {
  assert.equal(KEY.resource, 'system/keys')
  assert.equal(KEY.identityKey, 'keyId')
  assert.equal(KEY.sensitiveKeys, undefined)
})
