import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { HMAC_FUNCTION, buildHmacFunctionRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  id: 'sha256-webhook-hmac',
  worker_group: 'default',
  lib: 'custom',
  header_name: 'X-Signature',
  header_expression: "`sha256=${signatureString}`",
  string_builders: ["__e['__rawEvent']"],
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects a missing header_name', async () => {
  const res = await validate(ctxOf([{ ...good, header_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects empty string_builders', async () => {
  const res = await validate(ctxOf([{ ...good, string_builders: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good HMAC function', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildHmacFunctionRecord reads string_builders as an array or comma string', () => {
  const spec = buildHmacFunctionRecord({ ...good, string_builders: 'a,b,c' }, {})
  assert.deepEqual(spec.body?.stringBuilders, ['a', 'b', 'c'])
})

test('HMAC_FUNCTION targets the lib/hmac-functions collection', () => {
  assert.equal(HMAC_FUNCTION.resource, 'lib/hmac-functions')
})
