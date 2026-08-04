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
  name: 'security_admin_readonly',
  description: 'Read-only visibility into security incidents and ACLs',
  elevatedPrivilege: true,
  requiresSubscription: false,
  assignableBy: ['abc123def456abc123def456abc123de'],
}

test('validate accepts a well-formed role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'has a space' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate accepts a scoped role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'x_1234_myapp.manager' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_DESCRIPTION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sys_user_role columns with coerced types', () => {
  const body = spec.buildBody(good)
  assert.equal(body.name, 'security_admin_readonly')
  assert.equal(body.elevated_privilege, true)
  assert.equal(body.requires_subscription, false)
  assert.equal(body.assignable_by, 'abc123def456abc123def456abc123de')
})

test('spec.buildBody joins multiple assignable_by sys_ids with commas', () => {
  const body = spec.buildBody({ ...good, assignableBy: ['id1', 'id2', 'id1'] })
  assert.equal(body.assignable_by, 'id1,id2')
})
