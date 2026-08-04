import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  clientRoleMapsEqual,
  isClientRoleMapShape,
  normalizeClientRoleMap,
  projectFromFields,
  readClientRolesField,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers (deploy/rollback/drift) apply over the Keycloak Admin
 * REST API — including composite-role resolution — which is impractical to mock
 * here. Tests focus on validate.ts and the pure _shared helpers. Default Roles
 * is a SINGLETON, so the harness always wraps at most one item (not a list).
 */
function toItem(fields: Record<string, unknown>) {
  return { id: 'i0', name: 'Default Roles', fields }
}

function ctxOf(fields: Record<string, unknown> | null): PipelineContext {
  const items = fields ? [toItem(fields)] : []
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { realmRoles: ['offline_access', 'uma_authorization'], clientRoles: '{"account":["view-profile"]}' }

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf(null))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate errors when more than one item is declared', async () => {
  const ctx = { canvas: { items: [toItem(good), toItem(good)] } } as unknown as PipelineContext
  const res = await validate(ctx)
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MULTIPLE_ITEMS'))
})

test('validate accepts a good item', async () => {
  const res = await validate(ctxOf(good))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects invalid clientRoles JSON', async () => {
  const res = await validate(ctxOf({ ...good, clientRoles: '{not json' }))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ROLES_JSON'))
})

test('validate rejects clientRoles that is valid JSON but the wrong shape (not an object)', async () => {
  const res = await validate(ctxOf({ ...good, clientRoles: '["not","an","object"]' }))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ROLES_SHAPE'))
})

test('validate rejects clientRoles whose value is not a string array', async () => {
  const res = await validate(ctxOf({ ...good, clientRoles: '{"account": "view-profile"}' }))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ROLES_SHAPE'))
})

test('validate accepts a blank clientRoles field', async () => {
  const res = await validate(ctxOf({ realmRoles: ['offline_access'], clientRoles: '' }))
  assert.equal(res.valid, true)
})

test('validate warns when both realmRoles and clientRoles are empty', async () => {
  const res = await validate(ctxOf({ realmRoles: [], clientRoles: '' }))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_DEFAULT_ROLES'))
})

// --- _shared helpers ---------------------------------------------------------

test('isClientRoleMapShape accepts a plain object of non-empty string arrays', () => {
  assert.equal(isClientRoleMapShape({ account: ['view-profile'] }), true)
})

test('isClientRoleMapShape rejects arrays, non-array values and empty-string entries', () => {
  assert.equal(isClientRoleMapShape(['account']), false)
  assert.equal(isClientRoleMapShape({ account: 'view-profile' }), false)
  assert.equal(isClientRoleMapShape({ account: [''] }), false)
})

test('normalizeClientRoleMap trims keys/names, de-dupes and drops blanks', () => {
  assert.deepEqual(normalizeClientRoleMap({ ' account ': [' view-profile ', 'view-profile', ''], empty: [] }), {
    account: ['view-profile'],
  })
})

test('readClientRolesField parses a valid JSON object field', () => {
  assert.deepEqual(readClientRolesField({ clientRoles: '{"account":["view-profile"]}' }), {
    account: ['view-profile'],
  })
})

test('readClientRolesField returns {} for blank, invalid or wrongly-shaped JSON', () => {
  assert.deepEqual(readClientRolesField({}), {})
  assert.deepEqual(readClientRolesField({ clientRoles: '{not json' }), {})
  assert.deepEqual(readClientRolesField({ clientRoles: '["a"]' }), {})
})

test('projectFromFields combines realmRoles and clientRoles', () => {
  assert.deepEqual(projectFromFields(good), {
    realmRoles: ['offline_access', 'uma_authorization'],
    clientRoles: { account: ['view-profile'] },
  })
})

test('clientRoleMapsEqual compares per-client role lists as sets, order-insensitively', () => {
  assert.equal(clientRoleMapsEqual({ account: ['a', 'b'] }, { account: ['b', 'a'] }), true)
})

test('clientRoleMapsEqual is false when a client is missing or a role list differs', () => {
  assert.equal(clientRoleMapsEqual({ account: ['a'] }, { account: ['a'], other: ['b'] }), false)
  assert.equal(clientRoleMapsEqual({ account: ['a'] }, { account: ['b'] }), false)
})
