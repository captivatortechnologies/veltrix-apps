import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { COLLECTOR, parseCollectorConf, buildCollectorRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  id: 'collector-2',
  worker_group: 'default',
  conf: JSON.stringify({
    collector: { type: 'rest', conf: { discovery: [] } },
    input: { pipeline: 'main', output: 'default' },
  }),
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects conf that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects conf missing collector.type', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ "input": {} }' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good collector', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('parseCollectorConf auto-fills type: collection', () => {
  const { conf, error } = parseCollectorConf(good.conf)
  assert.equal(error, null)
  assert.equal(conf?.type, 'collection')
})

test('parseCollectorConf rejects an object without collector.type', () => {
  assert.ok(parseCollectorConf('{ "input": {} }').error)
})

test('buildCollectorRecord merges id with the parsed conf', () => {
  const spec = buildCollectorRecord(good, {})
  assert.equal(spec.error, null)
  assert.equal(spec.body?.id, 'collector-2')
  assert.equal(spec.body?.type, 'collection')
  assert.deepEqual((spec.body?.collector as Record<string, unknown>).type, 'rest')
})

test('COLLECTOR targets the lib/jobs collection', () => {
  assert.equal(COLLECTOR.resource, 'lib/jobs')
})
