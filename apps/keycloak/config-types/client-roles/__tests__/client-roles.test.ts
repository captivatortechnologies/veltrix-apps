import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildClientRoleRep, projectFromFields, projectFromLive, type KeycloakClientRoleRep } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https
 * (including client-UUID resolution), which is impractical to mock here. Tests
 * focus on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { clientId: 'web-app', name: 'viewer', description: 'Read-only access', composite: false }

// --- validate ----------------------------------------------------------------

test('validate rejects a missing clientId', async () => {
  const res = await validate(ctxOf([{ ...good, clientId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CLIENT_ID'))
})

test('validate rejects a missing role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE_NAME'))
})

test('validate rejects a role name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'view all' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLE_NAME'))
})

test('validate warns on a duplicate (clientId, name) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ROLE_NAME'))
})

test('validate does NOT warn when the same role name is used under different clients', async () => {
  const res = await validate(ctxOf([good, { ...good, clientId: 'api-service' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_ROLE_NAME'), false)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good client role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('buildClientRoleRep produces a full representation from fields', () => {
  const rep = buildClientRoleRep(good)
  assert.equal(rep.name, 'viewer')
  assert.equal(rep.description, 'Read-only access')
  assert.equal(rep.composite, false)
})

test('buildClientRoleRep preserves unmanaged fields from the existing role on update', () => {
  const existing: KeycloakClientRoleRep = {
    id: 'uuid-1',
    name: 'viewer',
    containerId: 'client-uuid-1',
    clientRole: true,
    attributes: { some: ['value'] },
  }
  const rep = buildClientRoleRep({ ...good, composite: true }, existing)
  assert.equal(rep.id, 'uuid-1')
  assert.equal(rep.containerId, 'client-uuid-1')
  assert.equal(rep.clientRole, true)
  assert.equal(rep.composite, true)
  assert.deepEqual(rep.attributes, { some: ['value'] })
})

test('buildClientRoleRep keeps a prior description when none is authored', () => {
  const existing: KeycloakClientRoleRep = { name: 'viewer', description: 'kept' }
  const rep = buildClientRoleRep({ name: 'viewer' }, existing)
  assert.equal(rep.description, 'kept')
})

test('projectFromFields and projectFromLive agree for an unchanged role', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakClientRoleRep = { name: 'viewer', description: 'Read-only access', composite: false }
  assert.deepEqual(projectFromLive(live), fromFields)
})
