import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { SCHEMA, buildSchemaRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'ocsf_1_1_0', worker_group: 'default', schema: '{"type":"object","properties":{"_raw":{"type":"string"}}}' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an empty schema', async () => {
  const res = await validate(ctxOf([{ ...good, schema: '  ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects a schema that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, schema: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good schema', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildSchemaRecord keeps the schema as a JSON string', () => {
  const spec = buildSchemaRecord({ ...good, description: 'OCSF base' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, { id: 'ocsf_1_1_0', schema: good.schema, description: 'OCSF base' })
})

test('SCHEMA targets the lib/schemas collection', () => {
  assert.equal(SCHEMA.resource, 'lib/schemas')
})
