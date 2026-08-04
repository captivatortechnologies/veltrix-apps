import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readManagedFields,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikScopeMapping,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Department Claim',
  scope_name: 'department',
  description: 'Shares the user department claim',
  expression: 'return {"department": request.user.group_attributes().get("department")}',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing scope_name', async () => {
  const res = await validate(ctxOf([{ ...good, scope_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE_NAME'))
})

test('validate rejects a missing expression', async () => {
  const res = await validate(ctxOf([{ ...good, expression: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXPRESSION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a fully populated mapping', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildCreateBody reflects declared fields', () => {
  const body = buildCreateBody(good) as Record<string, unknown>
  assert.equal(body.scope_name, 'department')
  assert.equal(body.expression, good.expression)
})

test('snapshotManagedFields reads a live mapping', () => {
  const live: AuthentikScopeMapping = {
    pk: 'uuid-1',
    name: 'Department Claim',
    scope_name: 'department',
    description: 'Shares the user department claim',
    expression: good.expression,
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.scopeName, 'department')
})

test('sameManagedFields detects a changed expression', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ ...good, expression: 'return {}' } as AuthentikScopeMapping)
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.scope_name, 'department')
})
