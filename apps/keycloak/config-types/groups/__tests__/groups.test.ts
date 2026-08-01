import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  attributesFromKeyValue,
  buildGroupRep,
  findGroupByName,
  projectAttributesFromLive,
  projectFromFields,
  singleValuedAttributes,
  topLevelPath,
  type KeycloakGroupRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers (deploy/rollback/drift) apply over the Keycloak Admin REST
 * API — including realm role-mapping reconciliation — which is impractical to mock
 * here. Tests focus on validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Engineering', attributes: { team: 'core' }, realmRoles: ['app-admin'] }

// --- validate ----------------------------------------------------------------

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP_NAME'))
})

test('validate rejects a group name containing a slash (sub-group)', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Engineering/Platform' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP_NAME'))
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, { ...good, attributes: {} }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('topLevelPath derives /name', () => {
  assert.equal(topLevelPath('Engineering'), '/Engineering')
})

test('attributesFromKeyValue wraps values in single-element lists', () => {
  assert.deepEqual(attributesFromKeyValue({ team: 'core', tier: '1' }), { team: ['core'], tier: ['1'] })
})

test('singleValuedAttributes flattens to the first value', () => {
  assert.deepEqual(singleValuedAttributes({ team: ['core', 'extra'], empty: [] }), { team: 'core' })
})

test('findGroupByName matches on exact top-level name', () => {
  const list: KeycloakGroupRep[] = [
    { id: 'g1', name: 'Engineering' },
    { id: 'g2', name: 'Sales' },
  ]
  assert.equal(findGroupByName(list, 'Sales')?.id, 'g2')
  assert.equal(findGroupByName(list, 'Missing'), null)
})

test('buildGroupRep produces name + wrapped attributes and omits realmRoles', () => {
  const rep = buildGroupRep(good)
  assert.equal(rep.name, 'Engineering')
  assert.deepEqual(rep.attributes, { team: ['core'] })
  assert.equal(rep.realmRoles, undefined)
})

test('buildGroupRep preserves unmanaged fields from the existing group on update', () => {
  const existing: KeycloakGroupRep = { id: 'g1', name: 'Engineering', subGroups: [{ name: 'Platform' }] }
  const rep = buildGroupRep(good, existing)
  assert.equal(rep.id, 'g1')
  assert.deepEqual(rep.subGroups, [{ name: 'Platform' }])
})

test('projectFromFields and the live attribute projection agree for an unchanged group', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakGroupRep = { id: 'g1', name: 'Engineering', attributes: { team: ['core'] } }
  assert.deepEqual(projectAttributesFromLive(live), fromFields.attributes)
  assert.deepEqual(fromFields.realmRoles, ['app-admin'])
})
