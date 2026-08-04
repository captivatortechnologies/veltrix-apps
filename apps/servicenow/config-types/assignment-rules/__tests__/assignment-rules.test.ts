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
  name: 'Route security incidents to SOC',
  table: 'sn_si_incident',
  active: true,
  condition: 'category=security',
  group: 'abc123def456abc123def456abc123de',
  user: '',
  script: '',
  order: 100,
  description: 'Auto-assign new security incidents to the SOC group',
}

test('validate accepts a well-formed assignment rule', async () => {
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

test('validate warns when no group, user or script is set', async () => {
  const res = await validate(ctxOf([{ ...good, group: '', user: '', script: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_ASSIGNMENT_TARGET'))
})

test('validate does not warn when only a script is set', async () => {
  const res = await validate(ctxOf([{ ...good, group: '', user: '', script: 'current.assignment_group = "x";' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'NO_ASSIGNMENT_TARGET'))
})

test('validate warns on a duplicate (name, table) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sysrule_assignment columns', () => {
  const body = spec.buildBody(good)
  assert.equal(body.name, 'Route security incidents to SOC')
  assert.equal(body.table, 'sn_si_incident')
  assert.equal(body.group, 'abc123def456abc123def456abc123de')
  assert.equal(body.order, 100)
})
