import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildDataViewFields } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over Kibana's Data Views REST API via node:https
 * inside soConsole, which is impractical to mock here. Tests focus on
 * validate.ts and the pure helper in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.dataViewId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects an unsafe data view ID', async () => {
  const res = await validate(ctxOf([{ dataViewId: 'bad id/../x', title: 'so-*', name: 'SO' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ID'))
})

test('validate requires a title and a name', async () => {
  const res = await validate(ctxOf([{ dataViewId: 'so-custom', title: '', name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unsafe time field name', async () => {
  const res = await validate(ctxOf([{ dataViewId: 'so-custom', title: 'so-custom-*', name: 'Custom', timeFieldName: 'bad field!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIME_FIELD'))
})

test('validate warns on a duplicate data view ID', async () => {
  const res = await validate(ctxOf([
    { dataViewId: 'so-custom', title: 'so-custom-*', name: 'Custom' },
    { dataViewId: 'so-custom', title: 'so-custom-2-*', name: 'Custom 2' },
  ]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate accepts a good data view', async () => {
  const res = await validate(ctxOf([{ dataViewId: 'so-custom-syslog', title: 'logs-custom-syslog-*', name: 'Custom Syslog', timeFieldName: '@timestamp' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildDataViewFields omits timeFieldName when blank', () => {
  assert.deepEqual(buildDataViewFields({ title: 'so-*', name: 'SO' }), { title: 'so-*', name: 'SO' })
})

test('buildDataViewFields includes a trimmed timeFieldName when set', () => {
  assert.deepEqual(
    buildDataViewFields({ title: 'so-*', name: 'SO', timeFieldName: ' @timestamp ' }),
    { title: 'so-*', name: 'SO', timeFieldName: '@timestamp' },
  )
})
