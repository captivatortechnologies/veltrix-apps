import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { DESTINATION, buildEntityBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * Destinations reuse the same lib/criblSystemEntities engine as Sources (deeply
 * unit-tested in the sources suite), so these tests confirm the Destination
 * descriptor is wired correctly and the shared validator behaves for outputs.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>, settings: Record<string, unknown> = {}): PipelineContext {
  return { canvas: { items: toItems(list) }, settings } as unknown as PipelineContext
}

const good = { id: 'out_splunk', type: 'splunk_hec', worker_group: 'default', conf: '{ "url": "https://splunk:8088" }' }

test('DESTINATION targets the system/outputs collection', () => {
  assert.equal(DESTINATION.resource, 'system/outputs')
  assert.equal(DESTINATION.kind, 'destination')
})

test('validate accepts a good destination', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate rejects conf that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conf: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONF'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildEntityBody flattens output conf onto id + type', () => {
  const body = buildEntityBody('out_s3', 's3', { bucket: 'logs', region: 'us-east-2' })
  assert.deepEqual(body, { id: 'out_s3', type: 's3', bucket: 'logs', region: 'us-east-2' })
})
