import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the ServiceNow Table API
 * (network) through the shared table-config engine, which is impractical to
 * mock here. Tests focus on validate.ts and the pure spec.buildBody mapping.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.shortDescription ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  shortDescription: 'Hide caller on P1',
  table: 'incident',
  description: 'Hide the caller field for priority-1 incidents',
  uiType: '10',
  active: true,
  global: true,
  onLoad: true,
  reverseIfFalse: true,
  runScripts: false,
  order: 100,
  conditions: 'priority=1',
}

test('validate accepts a well-formed UI policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing short description', async () => {
  const res = await validate(ctxOf([{ ...good, shortDescription: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SHORT_DESCRIPTION'))
})

test('validate rejects a missing table', async () => {
  const res = await validate(ctxOf([{ ...good, table: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TABLE'))
})

test('validate rejects an invalid table name', async () => {
  const res = await validate(ctxOf([{ ...good, table: 'Not A Table' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TABLE'))
})

test('validate rejects an unknown ui_type', async () => {
  const res = await validate(ctxOf([{ ...good, uiType: '7' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_UI_TYPE'))
})

test('validate accepts each valid ui_type', async () => {
  for (const uiType of ['0', '1', '10']) {
    const res = await validate(ctxOf([{ ...good, uiType }]))
    assert.equal(res.valid, true, `expected ui_type ${uiType} to be valid`)
  }
})

test('validate warns when a policy has no condition and does not run on load', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '', onLoad: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_APPLICABILITY'))
})

test('validate warns on a duplicate (short description, table) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate treats the same description on a different table as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, table: 'task' }]))
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_IDENTITY').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sys_ui_policy columns with coerced types', () => {
  const body = spec.buildBody(good)
  assert.equal(body.short_description, 'Hide caller on P1')
  assert.equal(body.table, 'incident')
  assert.equal(body.ui_type, '10')
  assert.equal(body.active, true)
  assert.equal(body.on_load, true)
  assert.equal(body.order, 100)
  assert.equal(body.conditions, 'priority=1')
})
