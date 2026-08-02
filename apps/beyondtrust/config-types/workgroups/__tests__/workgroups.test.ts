import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCreateBody, findWorkgroup, isGuid, workgroupIdentity, workgroupsFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the BeyondInsight REST API via
 * node:https inside beyondtrustApi, which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers (identity, list-unwrap, GUID check,
 * create-body), which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const good = { name: 'Data Center East', organizationId: '' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an over-long name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(257) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a non-GUID organization id', async () => {
  const res = await validate(ctxOf([{ ...good, organizationId: 'not-a-guid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ORG_ID'))
})

test('validate accepts a valid organization GUID', async () => {
  const res = await validate(ctxOf([{ ...good, organizationId: GUID }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { name: 'data center east', organizationId: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_WORKGROUP'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('isGuid accepts canonical GUIDs and rejects the rest', () => {
  assert.equal(isGuid(GUID), true)
  assert.equal(isGuid('00000000-0000-0000-0000-000000000000'), true)
  assert.equal(isGuid('not-a-guid'), false)
  assert.equal(isGuid(''), false)
  assert.equal(isGuid(undefined), false)
})

test('workgroupsFromList unwraps arrays and paginated containers', () => {
  assert.equal(workgroupsFromList([{ Name: 'a' }]).length, 1)
  assert.equal(workgroupsFromList({ Data: [{ Name: 'a' }, { Name: 'b' }] }).length, 2)
  assert.equal(workgroupsFromList(null).length, 0)
})

test('findWorkgroup matches on name, case-insensitively', () => {
  const live = [
    { ID: 1, Name: 'Data Center East' },
    { ID: 2, Name: 'Data Center West' },
  ]
  assert.equal(findWorkgroup(live, 'data center east')?.ID, 1)
  assert.equal(findWorkgroup(live, 'DATA CENTER WEST')?.ID, 2)
  assert.equal(findWorkgroup(live, 'Nope'), null)
})

test('workgroupIdentity is stable across casing and whitespace', () => {
  assert.equal(workgroupIdentity('  East '), workgroupIdentity('east'))
})

test('buildCreateBody keeps the name and omits a blank organization id', () => {
  assert.deepEqual(buildCreateBody({ name: 'East', organizationId: '' }), { Name: 'East' })
  assert.deepEqual(buildCreateBody({ name: 'East', organizationId: GUID }), { Name: 'East', OrganizationID: GUID })
})
