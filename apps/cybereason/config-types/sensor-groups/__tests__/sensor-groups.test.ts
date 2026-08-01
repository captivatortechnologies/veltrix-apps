import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildGroupBody,
  groupsFromResponse,
  findGroupByName,
  groupId,
  createdGroupId,
  isGuid,
  isValidJson,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Cybereason REST API via
 * node:https, which is impractical to mock here. Tests focus on validate.ts and
 * the pure _shared helpers — network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const GUID = '11111111-2222-3333-4444-555555555555'
const good = { name: 'Workstations', description: 'All laptops', policyId: GUID }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate warns on a non-GUID policy id', async () => {
  const res = await validate(ctxOf([{ ...good, policyId: 'not-a-guid' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'POLICY_ID_SHAPE'))
})

test('validate rejects an invalid JSON assignment rule', async () => {
  const res = await validate(ctxOf([{ ...good, groupAssignRule: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSIGN_RULE'))
})

test('validate accepts a valid JSON assignment rule', async () => {
  const res = await validate(ctxOf([{ ...good, groupAssignRule: '[{"field":"os","value":"WINDOWS"}]' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers --------------------------------------------------------

test('isGuid recognises a GUID and rejects junk', () => {
  assert.equal(isGuid(GUID), true)
  assert.equal(isGuid('abc'), false)
})

test('isValidJson accepts blank + valid JSON, rejects broken JSON', () => {
  assert.equal(isValidJson(''), true)
  assert.equal(isValidJson('{"a":1}'), true)
  assert.equal(isValidJson('{a:1'), false)
})

test('buildGroupBody omits blank optionals and parses the assign rule', () => {
  const body = buildGroupBody({ name: 'G', description: '', policyId: '', groupAssignRule: '[{"x":1}]' })
  assert.equal(body.name, 'G')
  assert.equal('description' in body, false)
  assert.equal('policyId' in body, false)
  assert.deepEqual(body.groupAssignRule, [{ x: 1 }])
})

test('groupsFromResponse unwraps a bare array and a { groups } envelope', () => {
  assert.equal(groupsFromResponse(JSON.stringify([{ name: 'a' }])).length, 1)
  assert.equal(groupsFromResponse(JSON.stringify({ groups: [{ name: 'b' }, { name: 'c' }] })).length, 2)
  assert.equal(groupsFromResponse('not json').length, 0)
})

test('findGroupByName matches case-insensitively', () => {
  const live = [{ id: 'g1', name: 'Servers' }]
  const match = findGroupByName(live, 'servers')
  assert.ok(match)
  assert.equal(match?.id, 'g1')
})

test('groupId prefers id then groupId', () => {
  assert.equal(groupId({ id: 'a', groupId: 'b' }), 'a')
  assert.equal(groupId({ groupId: 'b' }), 'b')
  assert.equal(groupId({}), '')
})

test('createdGroupId reads groupId or id from a create response', () => {
  assert.equal(createdGroupId(JSON.stringify({ groupId: 'new-1' })), 'new-1')
  assert.equal(createdGroupId(JSON.stringify({ id: 'new-2' })), 'new-2')
  assert.equal(createdGroupId('not json'), '')
})
