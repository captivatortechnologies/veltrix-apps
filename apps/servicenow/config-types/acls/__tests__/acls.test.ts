import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec, buildAclName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the ServiceNow Table API
 * (network) through the shared table-config engine, which is impractical to
 * mock here. Tests focus on validate.ts and the pure spec/buildAclName mapping.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.table ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  table: 'sn_si_incident',
  field: 'short_description',
  operation: 'write',
  active: true,
  adminOverrides: true,
  condition: 'active=true',
  script: '',
  description: 'Restrict edits to open security incidents',
}

test('validate accepts a well-formed ACL', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing table', async () => {
  const res = await validate(ctxOf([{ ...good, table: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TABLE'))
})

test('validate accepts the "*" global-table wildcard', async () => {
  const res = await validate(ctxOf([{ ...good, table: '*', field: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid table name', async () => {
  const res = await validate(ctxOf([{ ...good, table: 'Not A Table' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TABLE'))
})

test('validate rejects an invalid field name', async () => {
  const res = await validate(ctxOf([{ ...good, field: 'Not A Field' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FIELD'))
})

test('validate rejects an unknown operation', async () => {
  const res = await validate(ctxOf([{ ...good, operation: 'destroy_everything' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OPERATION'))
})

test('validate warns when an ACL has neither a condition nor a script', async () => {
  const res = await validate(ctxOf([{ ...good, condition: '', script: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_RESTRICTION'))
})

test('validate does not warn NO_RESTRICTION when a script is present', async () => {
  const res = await validate(ctxOf([{ ...good, condition: '', script: 'answer = true;' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'NO_RESTRICTION'))
})

test('validate warns on a duplicate (name, operation) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('buildAclName joins table and field with a dot', () => {
  assert.equal(buildAclName(good), 'sn_si_incident.short_description')
})

test('buildAclName omits the field when blank (table-level rule)', () => {
  assert.equal(buildAclName({ ...good, field: '' }), 'sn_si_incident')
})

test('spec.buildBody hardcodes type=record and maps operation/booleans', () => {
  const body = spec.buildBody(good)
  assert.equal(body.type, 'record')
  assert.equal(body.name, 'sn_si_incident.short_description')
  assert.equal(body.operation, 'write')
  assert.equal(body.active, true)
  assert.equal(body.admin_overrides, true)
})
