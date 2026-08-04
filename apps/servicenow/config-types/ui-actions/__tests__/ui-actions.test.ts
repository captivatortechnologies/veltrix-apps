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
  name: 'Escalate to SOC',
  table: 'sn_si_incident',
  actionName: 'escalate_to_soc',
  active: true,
  order: 100,
  hint: 'Escalate this incident to the SOC',
  comments: '',
  formButton: true,
  formLink: false,
  formContextMenu: false,
  listBannerButton: false,
  listChoice: false,
  listContextMenu: false,
  listLink: false,
  showInsert: true,
  showUpdate: true,
  showQuery: false,
  showMultipleUpdate: false,
  condition: 'current.active==true',
  client: false,
  onclick: '',
  isolateScript: true,
  script: "(function executeAction(current) { current.assignment_group = 'soc'; current.update(); })(current);",
}

test('validate accepts a well-formed UI action', async () => {
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

test('validate rejects an invalid table name', async () => {
  const res = await validate(ctxOf([{ ...good, table: 'Not A Table' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TABLE'))
})

test('validate rejects a client action with no onclick', async () => {
  const res = await validate(ctxOf([{ ...good, client: true, onclick: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ONCLICK'))
})

test('validate accepts a client action with an onclick', async () => {
  const res = await validate(ctxOf([{ ...good, client: true, onclick: 'doThing()', script: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a non-client action with no script', async () => {
  const res = await validate(ctxOf([{ ...good, client: false, script: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_SERVER_SCRIPT'))
})

test('validate warns when no placement flag is set', async () => {
  const res = await validate(ctxOf([{ ...good, formButton: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NOT_VISIBLE'))
})

test('validate warns on a duplicate (name, table) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, hint: 'other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps every placement and show flag', () => {
  const body = spec.buildBody(good)
  assert.equal(body.form_button, true)
  assert.equal(body.list_link, false)
  assert.equal(body.show_insert, true)
  assert.equal(body.show_multiple_update, false)
  assert.equal(body.action_name, 'escalate_to_soc')
})
