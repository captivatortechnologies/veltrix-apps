import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { SUBSCRIPTION, buildSubscriptionRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'my-subscription', worker_group: 'default', pipeline: 'main', disabled: false }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects a missing pipeline', async () => {
  const res = await validate(ctxOf([{ ...good, pipeline: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good subscription', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildSubscriptionRecord builds the full body', () => {
  const spec = buildSubscriptionRecord({ ...good, description: 'ingest syslog', filter: 'true' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, { id: 'my-subscription', pipeline: 'main', disabled: false, description: 'ingest syslog', filter: 'true' })
})

test('SUBSCRIPTION targets the system/subscriptions collection', () => {
  assert.equal(SUBSCRIPTION.resource, 'system/subscriptions')
})
