import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  attributesFromKeyValue,
  buildPermissionRep,
  buildResourceRep,
  buildRolePolicyRep,
  buildScopeRep,
  findByExactName,
  parseRoleEntriesField,
  parseRoleRefName,
  projectScopeFields,
  roleRefSetsEqual,
  singleValuedAttributes,
  type KeycloakPermissionRep,
  type KeycloakResourceRep,
  type KeycloakRolePolicyRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodResource = { clientId: 'web-app', kind: 'resource', name: 'Documents', uris: ['/api/documents/*'] }
const goodScope = { clientId: 'web-app', kind: 'scope', name: 'view' }
const goodPermission = {
  clientId: 'web-app',
  kind: 'permission',
  name: 'Documents Permission',
  permissionType: 'resource',
  decisionStrategy: 'UNANIMOUS',
}
const goodRolePolicy = {
  clientId: 'web-app',
  kind: 'role-policy',
  name: 'Admin Only',
  logic: 'POSITIVE',
  decisionStrategy: 'UNANIMOUS',
  roles: JSON.stringify([{ name: 'admin', required: true }]),
}

// --- validate: common fields ---------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing clientId', async () => {
  const res = await validate(ctxOf([{ ...goodResource, clientId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CLIENT_ID'))
})

test('validate rejects a missing kind', async () => {
  const res = await validate(ctxOf([{ ...goodResource, kind: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KIND'))
})

test('validate rejects an unknown kind', async () => {
  const res = await validate(ctxOf([{ ...goodResource, kind: 'client-policy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_KIND'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodResource, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate allows a name containing spaces (unlike this app\'s other identity fields)', async () => {
  const res = await validate(ctxOf([{ ...goodResource, name: 'Default Resource' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a good item of each kind', async () => {
  for (const item of [goodResource, goodScope, goodPermission, goodRolePolicy]) {
    const res = await validate(ctxOf([item]))
    assert.equal(res.valid, true, `expected ${item.kind} to be valid: ${JSON.stringify(res.errors)}`)
    assert.equal(res.errors.length, 0)
  }
})

// --- validate: permission-specific ----------------------------------------------

test('validate rejects a permission missing permissionType', async () => {
  const res = await validate(ctxOf([{ ...goodPermission, permissionType: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PERMISSION_TYPE'))
})

test('validate rejects a permission with an unknown permissionType', async () => {
  const res = await validate(ctxOf([{ ...goodPermission, permissionType: 'realm' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PERMISSION_TYPE'))
})

test('validate rejects an unknown decisionStrategy on a permission', async () => {
  const res = await validate(ctxOf([{ ...goodPermission, decisionStrategy: 'MAJORITY' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DECISION_STRATEGY'))
})

test('validate does not require permissionType/decisionStrategy for a resource or scope item', async () => {
  const res = await validate(ctxOf([goodResource, goodScope]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- validate: role-policy-specific ----------------------------------------------

test('validate rejects an unknown logic on a role-policy', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, logic: 'MAYBE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LOGIC'))
})

test('validate rejects an unknown decisionStrategy on a role-policy', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, decisionStrategy: 'MAJORITY' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DECISION_STRATEGY'))
})

test('validate rejects role-policy roles that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate rejects role-policy roles that are blank', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate rejects role-policy roles that are not an array', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: JSON.stringify({ name: 'admin', required: true }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate rejects role-policy roles that parse to an empty array', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate rejects a role-policy roles entry missing "name"', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: JSON.stringify([{ required: true }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate rejects a role-policy roles entry missing boolean "required"', async () => {
  const res = await validate(ctxOf([{ ...goodRolePolicy, roles: JSON.stringify([{ name: 'admin' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLES'))
})

test('validate accepts a role-policy roles entry naming a client role (clientId/roleName)', async () => {
  const res = await validate(
    ctxOf([{ ...goodRolePolicy, roles: JSON.stringify([{ name: 'my-client/some-role', required: false }]) }]),
  )
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- validate: composite (clientId, kind, name) identity -------------------------

test('validate warns on a duplicate (clientId, kind, name) composite', async () => {
  const res = await validate(ctxOf([goodResource, { ...goodResource, uris: ['/other/*'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ITEM'))
})

test('validate allows the same name across two different kinds on the same client', async () => {
  const res = await validate(ctxOf([{ ...goodResource, name: 'Documents' }, { ...goodScope, name: 'Documents' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_ITEM').length, 0)
})

test('validate allows the same (kind, name) across two different clients', async () => {
  const res = await validate(ctxOf([goodResource, { ...goodResource, clientId: 'other-app' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_ITEM').length, 0)
})

// --- _shared: parseRoleRefName (bare realm-role vs clientId/roleName) -----------

test('parseRoleRefName treats a plain name as a bare realm-role name', () => {
  assert.deepEqual(parseRoleRefName('admin'), { roleName: 'admin' })
})

test('parseRoleRefName splits "clientId/roleName" on the first slash', () => {
  assert.deepEqual(parseRoleRefName('my-client/some-role'), { clientId: 'my-client', roleName: 'some-role' })
})

test('parseRoleRefName splits only on the FIRST slash, preserving the rest in roleName', () => {
  assert.deepEqual(parseRoleRefName('my-client/nested/role'), { clientId: 'my-client', roleName: 'nested/role' })
})

test('parseRoleRefName treats a leading slash as a bare name (no client prefix)', () => {
  assert.deepEqual(parseRoleRefName('/admin'), { roleName: '/admin' })
})

test('parseRoleRefName treats a trailing slash as a bare name (no role suffix)', () => {
  assert.deepEqual(parseRoleRefName('my-client/'), { roleName: 'my-client/' })
})

test('parseRoleRefName treats a name with no slash at all as bare', () => {
  assert.deepEqual(parseRoleRefName('offline_access'), { roleName: 'offline_access' })
})

// --- _shared: parseRoleEntriesField ---------------------------------------------

test('parseRoleEntriesField parses a well-formed roles array', () => {
  const { entries, error } = parseRoleEntriesField(
    JSON.stringify([
      { name: 'admin', required: true },
      { name: 'my-client/some-role', required: false },
    ]),
  )
  assert.equal(error, null)
  assert.deepEqual(entries, [
    { name: 'admin', required: true },
    { name: 'my-client/some-role', required: false },
  ])
})

test('parseRoleEntriesField errors on invalid JSON', () => {
  const { entries, error } = parseRoleEntriesField('{not json')
  assert.equal(entries, null)
  assert.match(error ?? '', /not valid JSON/)
})

test('parseRoleEntriesField errors on a blank value', () => {
  const { entries, error } = parseRoleEntriesField('')
  assert.equal(entries, null)
  assert.match(error ?? '', /is required/)
})

test('parseRoleEntriesField errors on a non-array', () => {
  const { entries, error } = parseRoleEntriesField(JSON.stringify({ name: 'admin', required: true }))
  assert.equal(entries, null)
  assert.match(error ?? '', /non-empty JSON array/)
})

test('parseRoleEntriesField errors on an empty array', () => {
  const { entries, error } = parseRoleEntriesField('[]')
  assert.equal(entries, null)
  assert.match(error ?? '', /non-empty JSON array/)
})

test('parseRoleEntriesField errors on an entry missing "name"', () => {
  const { entries, error } = parseRoleEntriesField(JSON.stringify([{ required: true }]))
  assert.equal(entries, null)
  assert.match(error ?? '', /missing a non-empty "name"/)
})

test('parseRoleEntriesField errors on an entry with a non-boolean "required"', () => {
  const { entries, error } = parseRoleEntriesField(JSON.stringify([{ name: 'admin', required: 'yes' }]))
  assert.equal(entries, null)
  assert.match(error ?? '', /missing a boolean "required"/)
})

// --- _shared: small pure helpers -------------------------------------------------

test('findByExactName matches on name only, ignoring surrounding whitespace', () => {
  const list = [{ id: '1', name: 'Documents' }, { id: '2', name: 'Reports ' }]
  assert.equal(findByExactName(list, 'Documents')?.id, '1')
  assert.equal(findByExactName(list, 'Reports')?.id, '2')
  assert.equal(findByExactName(list, 'missing'), null)
})

test('attributesFromKeyValue / singleValuedAttributes round-trip a flat map', () => {
  const flat = { department: 'engineering', tier: 'gold' }
  const wrapped = attributesFromKeyValue(flat)
  assert.deepEqual(wrapped, { department: ['engineering'], tier: ['gold'] })
  assert.deepEqual(singleValuedAttributes(wrapped), flat)
})

test('singleValuedAttributes tolerates an undefined/empty attributes map', () => {
  assert.deepEqual(singleValuedAttributes(undefined), {})
  assert.deepEqual(singleValuedAttributes({}), {})
})

test('roleRefSetsEqual is order-insensitive but sensitive to id and required', () => {
  const a = [{ id: '1', required: true }, { id: '2', required: false }]
  const b = [{ id: '2', required: false }, { id: '1', required: true }]
  assert.equal(roleRefSetsEqual(a, b), true)
  assert.equal(roleRefSetsEqual(a, [{ id: '1', required: false }, { id: '2', required: false }]), false)
  assert.equal(roleRefSetsEqual(a, [{ id: '1', required: true }]), false)
})

test('projectScopeFields reads displayName and iconUri, undefined when unset', () => {
  assert.deepEqual(projectScopeFields({ displayName: 'View', iconUri: 'https://example.com/icon.png' }), {
    displayName: 'View',
    iconUri: 'https://example.com/icon.png',
  })
  assert.deepEqual(projectScopeFields({}), { displayName: undefined, iconUri: undefined })
})

// --- _shared: buildXRep -----------------------------------------------------------

test('buildResourceRep builds a full representation with resolved scope refs', () => {
  const rep = buildResourceRep(
    { name: 'Documents', displayName: 'Docs', uris: ['/api/documents/*'], type: 'urn:app:doc', ownerManagedAccess: true, attributes: { dept: 'eng' } },
    [{ id: 'scope-1', name: 'view' }],
  )
  assert.equal(rep.name, 'Documents')
  assert.equal(rep.displayName, 'Docs')
  assert.deepEqual(rep.uris, ['/api/documents/*'])
  assert.deepEqual(rep.scopes, [{ id: 'scope-1', name: 'view' }])
  assert.equal(rep.type, 'urn:app:doc')
  assert.equal(rep.ownerManagedAccess, true)
  assert.deepEqual(rep.attributes, { dept: ['eng'] })
})

test('buildResourceRep preserves unmanaged base fields and keeps prior displayName/type when omitted', () => {
  const base: KeycloakResourceRep = { id: 'uuid-1', name: 'Documents', displayName: 'kept', type: 'kept-type', owner: { id: 'client-1' } }
  const rep = buildResourceRep({ name: 'Documents' }, [], base)
  assert.equal(rep.id, 'uuid-1')
  assert.deepEqual(rep.owner, { id: 'client-1' })
  assert.equal(rep.displayName, 'kept')
  assert.equal(rep.type, 'kept-type')
})

test('buildScopeRep builds a representation and merges forward when a field is omitted', () => {
  const rep = buildScopeRep({ name: 'view', displayName: 'View' })
  assert.equal(rep.name, 'view')
  assert.equal(rep.displayName, 'View')
  assert.equal(rep.iconUri, undefined)

  const base: { id?: string; name?: string; iconUri?: string } = { id: 'uuid-1', name: 'view', iconUri: 'kept-icon' }
  const updated = buildScopeRep({ name: 'view' }, base)
  assert.equal(updated.id, 'uuid-1')
  assert.equal(updated.iconUri, 'kept-icon')
})

test('buildPermissionRep includes resources/resourceType only for a resource-based permission', () => {
  const resourceBased = buildPermissionRep(
    { name: 'Doc Permission', permissionType: 'resource', decisionStrategy: 'AFFIRMATIVE', resourceType: 'urn:app:doc' },
    [{ id: 'policy-1', name: 'Admin Only' }],
    [{ id: 'resource-1', name: 'Documents' }],
    [{ id: 'scope-1', name: 'view' }],
  )
  assert.equal(resourceBased.decisionStrategy, 'AFFIRMATIVE')
  assert.deepEqual(resourceBased.policies, ['policy-1'])
  assert.deepEqual(resourceBased.scopes, ['scope-1'])
  assert.deepEqual(resourceBased.resources, ['resource-1'])
  assert.equal(resourceBased.resourceType, 'urn:app:doc')

  const scopeBased = buildPermissionRep(
    { name: 'Scope Permission', permissionType: 'scope' },
    [{ id: 'policy-1', name: 'Admin Only' }],
    [{ id: 'resource-1', name: 'Documents' }],
    [{ id: 'scope-1', name: 'view' }],
  )
  assert.equal(scopeBased.resources, undefined)
  assert.equal(scopeBased.resourceType, undefined)
  assert.equal(scopeBased.decisionStrategy, 'UNANIMOUS')
})

test('buildPermissionRep preserves unmanaged base fields and keeps prior description when omitted', () => {
  const base: KeycloakPermissionRep = { id: 'uuid-1', name: 'Doc Permission', type: 'resource', description: 'kept' }
  const rep = buildPermissionRep({ name: 'Doc Permission', permissionType: 'scope' }, [], [], [], base)
  assert.equal(rep.id, 'uuid-1')
  assert.equal(rep.type, 'resource')
  assert.equal(rep.description, 'kept')
})

test('buildRolePolicyRep builds a full representation with resolved role refs', () => {
  const rep = buildRolePolicyRep(
    { name: 'Admin Only', description: 'Admins only', decisionStrategy: 'UNANIMOUS', logic: 'POSITIVE' },
    [{ id: 'role-1', required: true }],
  )
  assert.equal(rep.name, 'Admin Only')
  assert.equal(rep.description, 'Admins only')
  assert.equal(rep.decisionStrategy, 'UNANIMOUS')
  assert.equal(rep.logic, 'POSITIVE')
  assert.deepEqual(rep.roles, [{ id: 'role-1', required: true }])
})

test('buildRolePolicyRep preserves unmanaged base fields and keeps prior description when omitted', () => {
  const base: KeycloakRolePolicyRep = { id: 'uuid-1', name: 'Admin Only', type: 'role', description: 'kept' }
  const rep = buildRolePolicyRep({ name: 'Admin Only' }, [{ id: 'role-1', required: true }], base)
  assert.equal(rep.id, 'uuid-1')
  assert.equal(rep.type, 'role')
  assert.equal(rep.description, 'kept')
  assert.equal(rep.decisionStrategy, 'UNANIMOUS')
  assert.equal(rep.logic, 'POSITIVE')
})
