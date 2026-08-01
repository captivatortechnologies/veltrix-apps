import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEndpointGroupBody, findGroupByName, groupsFromReply, isValidFilterJson } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the Cortex XDR REST API, which is impractical
 * to mock here. Tests focus on validate.ts and the pure _shared helpers (identity
 * matching + body building + filter parsing) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Workstations', description: 'All laptops', group_type: 'static' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed static group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown group type', async () => {
  const res = await validate(ctxOf([{ ...good, group_type: 'ephemeral' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP_TYPE'))
})

test('validate rejects an invalid JSON filter', async () => {
  const res = await validate(ctxOf([{ ...good, group_type: 'dynamic', filter: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER'))
})

test('validate accepts a dynamic group with a valid JSON filter', async () => {
  const res = await validate(ctxOf([{ ...good, group_type: 'dynamic', filter: '{"os":"WINDOWS"}' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a dynamic group with no filter', async () => {
  const res = await validate(ctxOf([{ ...good, group_type: 'dynamic', filter: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_DYNAMIC_FILTER'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('isValidFilterJson accepts blank + valid JSON, rejects broken JSON', () => {
  assert.equal(isValidFilterJson(''), true)
  assert.equal(isValidFilterJson('{"a":1}'), true)
  assert.equal(isValidFilterJson('{a:1'), false)
})

test('buildEndpointGroupBody parses the filter and omits empty description', () => {
  const body = buildEndpointGroupBody({ name: 'G', group_type: 'dynamic', filter: '{"os":"WINDOWS"}' })
  assert.equal(body.name, 'G')
  assert.equal(body.group_type, 'dynamic')
  assert.deepEqual(body.filter, { os: 'WINDOWS' })
  assert.equal('description' in body, false)
})

test('groupsFromReply unwraps array, { groups } and { endpoint_groups } shapes', () => {
  assert.equal(groupsFromReply([{ name: 'a' }]).length, 1)
  assert.equal(groupsFromReply({ groups: [{ name: 'b' }] }).length, 1)
  assert.equal(groupsFromReply({ endpoint_groups: [{ name: 'c' }, { name: 'd' }] }).length, 2)
  assert.equal(groupsFromReply(null).length, 0)
})

test('findGroupByName matches case-insensitively on name or group_name', () => {
  const live = [{ group_name: 'Servers', group_type: 'static' }]
  const match = findGroupByName(live, 'servers')
  assert.ok(match)
  assert.equal(match?.group_type, 'static')
})
