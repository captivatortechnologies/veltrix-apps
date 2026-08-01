import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the ServiceNow Table API
 * (network), which is impractical to mock here. Tests focus on validate.ts,
 * which is pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Auto-assign Sec Incidents',
  collection: 'sn_si_incident',
  when: 'before',
  order: 100,
  active: true,
  advanced: true,
  actionInsert: true,
  actionUpdate: false,
  actionDelete: false,
  actionQuery: false,
  filterCondition: 'active=true',
  script: '(function executeRule(current, previous) { current.assignment_group = "soc"; })(current, previous);',
}

test('validate accepts a well-formed business rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing table (collection)', async () => {
  const res = await validate(ctxOf([{ ...good, collection: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TABLE'))
})

test('validate rejects an invalid table name', async () => {
  const res = await validate(ctxOf([{ ...good, collection: 'Not A Table' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TABLE'))
})

test('validate rejects an unknown "when" value', async () => {
  const res = await validate(ctxOf([{ ...good, when: 'whenever' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WHEN'))
})

test('validate accepts each valid "when" value', async () => {
  for (const when of ['before', 'after', 'async', 'display']) {
    const res = await validate(ctxOf([{ ...good, when }]))
    assert.equal(res.valid, true, `expected ${when} to be valid`)
  }
})

test('validate rejects a missing script', async () => {
  const res = await validate(ctxOf([{ ...good, script: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT'))
})

test('validate warns when no trigger is selected', async () => {
  const res = await validate(ctxOf([{ ...good, actionInsert: false, actionUpdate: false, actionDelete: false, actionQuery: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_TRIGGER'))
})

test('validate warns on a duplicate (name, table) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, script: 'other();' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate treats the same name on a different table as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, collection: 'incident' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_IDENTITY').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
