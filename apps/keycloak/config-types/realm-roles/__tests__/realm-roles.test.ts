import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRoleRep, projectFromFields, projectFromLive, type KeycloakRoleRep } from '../_shared'
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

const good = { name: 'app-admin', description: 'App administrators', composite: false }

// --- validate ----------------------------------------------------------------

test('validate rejects a missing role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE_NAME'))
})

test('validate rejects a role name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'app admin' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLE_NAME'))
})

test('validate warns on a duplicate role name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ROLE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('buildRoleRep produces a full representation from fields', () => {
  const rep = buildRoleRep(good)
  assert.equal(rep.name, 'app-admin')
  assert.equal(rep.description, 'App administrators')
  assert.equal(rep.composite, false)
})

test('buildRoleRep preserves unmanaged fields from the existing role on update', () => {
  const existing: KeycloakRoleRep = {
    id: 'uuid-1',
    name: 'app-admin',
    containerId: 'realm-master',
    attributes: { some: ['value'] },
  }
  const rep = buildRoleRep({ ...good, composite: true }, existing)
  assert.equal(rep.id, 'uuid-1')
  assert.equal(rep.containerId, 'realm-master')
  assert.equal(rep.composite, true)
  assert.deepEqual(rep.attributes, { some: ['value'] })
})

test('buildRoleRep keeps a prior description when none is authored', () => {
  const existing: KeycloakRoleRep = { name: 'app-admin', description: 'kept' }
  const rep = buildRoleRep({ name: 'app-admin' }, existing)
  assert.equal(rep.description, 'kept')
})

test('projectFromFields and projectFromLive agree for an unchanged role', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakRoleRep = { name: 'app-admin', description: 'App administrators', composite: false }
  assert.deepEqual(projectFromLive(live), fromFields)
})
