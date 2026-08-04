import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { NOTIFICATION, buildNotificationRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  id: 'high-volume-http-src',
  condition: 'high-volume',
  targets: ['system_notifications'],
  disabled: false,
  conf: '{ "name": "in_http", "timeWindow": "60s", "dataVolume": "1GB" }',
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects a missing condition', async () => {
  const res = await validate(ctxOf([{ ...good, condition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects conf that is not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conf: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects metadata that is not an array', async () => {
  const res = await validate(ctxOf([{ ...good, metadata: '{ "name": "env" }' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good notification', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildNotificationRecord builds the full body, targets as an array', () => {
  const spec = buildNotificationRecord({ ...good, group: 'default', metadata: '[{"name":"env","value":"prod"}]' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, {
    id: 'high-volume-http-src',
    condition: 'high-volume',
    disabled: false,
    targets: ['system_notifications'],
    group: 'default',
    conf: { name: 'in_http', timeWindow: '60s', dataVolume: '1GB' },
    metadata: [{ name: 'env', value: 'prod' }],
  })
})

test('buildNotificationRecord omits targets/group/conf/metadata when blank', () => {
  const spec = buildNotificationRecord({ id: 'x', condition: 'no-data' }, {})
  assert.deepEqual(spec.body, { id: 'x', condition: 'no-data', disabled: false })
})

test('NOTIFICATION is a flat, non-group-scoped collection', () => {
  assert.equal(NOTIFICATION.resource, 'notifications')
  assert.equal(NOTIFICATION.groupScoped, false)
})
