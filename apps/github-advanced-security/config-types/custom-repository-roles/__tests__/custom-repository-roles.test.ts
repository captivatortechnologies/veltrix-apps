import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, buildRoleBody, roleBodyChanges, restoreBody, toStringArray, type CustomRepositoryRole } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { org: 'octo-org', name: 'Deploy Manager', description: 'Can manage deploys', base_role: 'write', permissions: ['manage_deploy_keys'] }

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing org / name', async () => {
  const res = await validate(ctxOf([{ ...good, org: '', name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORG'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (org, name)', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ROLE'))
})

test('validate rejects an invalid base role', async () => {
  const res = await validate(ctxOf([{ ...good, base_role: 'admin' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BASE_ROLE'))
})

test('validate warns when no additional permissions are listed', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: [] }]))
  assert.ok(res.warnings.some((w) => w.code === 'NO_ADDITIONAL_PERMISSIONS'))
})

// --- _shared ----------------------------------------------------------------

test('toStringArray parses tolerant input', () => {
  assert.deepEqual(toStringArray('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(toStringArray(['x']), ['x'])
})

test('desiredFromItem reads identity, base role and permissions', () => {
  const d = desiredFromItem(good)
  assert.equal(d.org, 'octo-org')
  assert.equal(d.baseRole, 'write')
  assert.deepEqual(d.permissions, ['manage_deploy_keys'])
})

test('buildRoleBody omits a blank description', () => {
  const body = buildRoleBody(desiredFromItem({ ...good, description: '' }))
  assert.equal('description' in body, false)
  assert.deepEqual(body.permissions, ['manage_deploy_keys'])
})

test('roleBodyChanges returns only fields that differ from live (permission order ignored)', () => {
  const desired = desiredFromItem(good)
  const live: CustomRepositoryRole = { id: 1, name: 'Deploy Manager', description: 'Can manage deploys', base_role: 'write', permissions: ['manage_deploy_keys'] }
  assert.deepEqual(roleBodyChanges(desired, live), {})
  const liveDiff: CustomRepositoryRole = { ...live, base_role: 'read' }
  assert.deepEqual(roleBodyChanges(desired, liveDiff), { base_role: 'write' })
})

test('restoreBody reconstructs a PATCH body from a prior role', () => {
  const body = restoreBody({ id: 1, name: 'X', description: 'd', base_role: 'read', permissions: ['a'] })
  assert.equal(body.name, 'X')
  assert.equal(body.base_role, 'read')
  assert.deepEqual(body.permissions, ['a'])
})
