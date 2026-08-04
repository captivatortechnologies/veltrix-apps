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
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Require close code',
  table: 'incident',
  type: 'onChange',
  fieldName: 'state',
  script: "function onChange(control, oldValue, newValue, isLoading) { if (isLoading) return; g_form.setMandatory('close_code', newValue == '7'); }",
  active: true,
  global: true,
  order: 100,
  description: '',
  appliesExtended: false,
  isolateScript: true,
  uiType: 'all',
}

test('validate accepts a well-formed client script', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing table', async () => {
  const res = await validate(ctxOf([{ ...good, table: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TABLE'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'onHover' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects onChange with no field name', async () => {
  const res = await validate(ctxOf([{ ...good, fieldName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FIELD_NAME'))
})

test('validate warns when a field name is set on onLoad', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'onLoad', fieldName: 'state' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNUSED_FIELD_NAME'))
})

test('validate rejects a missing script', async () => {
  const res = await validate(ctxOf([{ ...good, script: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT'))
})

test('validate rejects an invalid ui_type', async () => {
  const res = await validate(ctxOf([{ ...good, uiType: 'holodeck' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_UI_TYPE'))
})

test('validate warns on a duplicate (name, table, type) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate treats the same name/table with a different type as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, type: 'onSubmit', fieldName: '' }]))
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_IDENTITY').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sys_script_client columns', () => {
  const body = spec.buildBody(good)
  assert.equal(body.field_name, 'state')
  assert.equal(body.type, 'onChange')
  assert.equal(body.ui_type, 'all')
  assert.equal(body.isolate_script, true)
})
