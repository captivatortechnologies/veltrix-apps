import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRoleBody,
  diffPermissions,
  findRoleByName,
  normalizePermissions,
  parsePermissions,
  samePermissions,
  type Auth0Permission,
  type Auth0Role,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Orders Admin',
  description: 'Full access to the Orders API',
  permissions: 'https://api.example.com/orders|read:orders\nhttps://api.example.com/orders write:orders',
}

// --- validate ---------------------------------------------------------------

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

test('validate rejects a name containing < or >', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Bad<Role>' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a malformed permission line', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: 'just-one-token' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PERMISSION'))
})

test('validate warns on a duplicate role name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good role with no permissions', async () => {
  const res = await validate(ctxOf([{ name: 'Reader', description: 'Read only', permissions: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers --------------------------------------------------------

test('buildRoleBody includes description when set and omits it when blank', () => {
  assert.deepEqual(buildRoleBody({ name: 'A', description: 'desc' }), { name: 'A', description: 'desc' })
  const noDesc = buildRoleBody({ name: 'A', description: '' }) as unknown as Record<string, unknown>
  assert.equal('description' in noDesc, false)
})

test('parsePermissions parses pipe and whitespace forms and de-duplicates', () => {
  const perms = parsePermissions(good.permissions + '\nhttps://api.example.com/orders|read:orders')
  assert.deepEqual(perms, [
    { resource_server_identifier: 'https://api.example.com/orders', permission_name: 'read:orders' },
    { resource_server_identifier: 'https://api.example.com/orders', permission_name: 'write:orders' },
  ])
})

test('parsePermissions drops blank and malformed lines', () => {
  const perms = parsePermissions('\n  \nbadline\nurn:api|do:it')
  assert.deepEqual(perms, [{ resource_server_identifier: 'urn:api', permission_name: 'do:it' }])
})

test('diffPermissions computes additions and removals', () => {
  const desired: Auth0Permission[] = [
    { resource_server_identifier: 'urn:a', permission_name: 'read' },
    { resource_server_identifier: 'urn:a', permission_name: 'write' },
  ]
  const current: Auth0Permission[] = [
    { resource_server_identifier: 'urn:a', permission_name: 'read' },
    { resource_server_identifier: 'urn:a', permission_name: 'delete' },
  ]
  const { toAdd, toRemove } = diffPermissions(desired, current)
  assert.deepEqual(toAdd, [{ resource_server_identifier: 'urn:a', permission_name: 'write' }])
  assert.deepEqual(toRemove, [{ resource_server_identifier: 'urn:a', permission_name: 'delete' }])
})

test('samePermissions is order-insensitive', () => {
  const a: Auth0Permission[] = [
    { resource_server_identifier: 'urn:a', permission_name: 'read' },
    { resource_server_identifier: 'urn:a', permission_name: 'write' },
  ]
  const b: Auth0Permission[] = [
    { resource_server_identifier: 'urn:a', permission_name: 'write' },
    { resource_server_identifier: 'urn:a', permission_name: 'read' },
  ]
  assert.equal(samePermissions(a, b), true)
  assert.equal(samePermissions(a, [a[0]]), false)
})

test('normalizePermissions trims and drops incomplete grants', () => {
  const norm = normalizePermissions([
    { resource_server_identifier: ' urn:a ', permission_name: ' read ' },
    { resource_server_identifier: 'urn:a', permission_name: '' },
    { permission_name: 'x' },
  ])
  assert.deepEqual(norm, [{ resource_server_identifier: 'urn:a', permission_name: 'read' }])
})

test('findRoleByName matches by trimmed name', () => {
  const roles: Auth0Role[] = [
    { id: 'rol_1', name: 'Orders Admin' },
    { id: 'rol_2', name: 'Reader' },
  ]
  assert.equal(findRoleByName(roles, 'Reader')?.id, 'rol_2')
  assert.equal(findRoleByName(roles, 'Missing'), null)
})
