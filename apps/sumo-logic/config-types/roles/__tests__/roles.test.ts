import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRoleBody, findRole, rolesFromList, toStringList, type Role } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'SOC Analyst',
  description: 'Read-only SOC access',
  filterPredicate: '_sourceCategory=prod/*',
  capabilities: ['viewCollectors', 'searchAuditIndex'],
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a role with no capabilities', async () => {
  const res = await validate(ctxOf([{ ...good, capabilities: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_CAPABILITIES'))
})

test('validate warns on a duplicate role name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('toStringList accepts arrays and comma strings, trims and de-dupes', () => {
  assert.deepEqual(toStringList(['a', ' b ', 'a']), ['a', 'b'])
  assert.deepEqual(toStringList('a, b ,,a'), ['a', 'b'])
  assert.deepEqual(toStringList(''), [])
  assert.deepEqual(toStringList(null), [])
})

test('buildRoleBody trims fields, normalizes capabilities and omits id/users', () => {
  const body = buildRoleBody({ name: '  SOC  ', description: ' d ', filterPredicate: ' f ', capabilities: ['x', 'x', 'y'] })
  assert.deepEqual(body, { name: 'SOC', description: 'd', filterPredicate: 'f', capabilities: ['x', 'y'] })
})

test('rolesFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const roles: Role[] = [{ id: '1', name: 'a', capabilities: [] }]
  assert.deepEqual(rolesFromList({ data: roles }), roles)
  assert.deepEqual(rolesFromList(roles), roles)
  assert.deepEqual(rolesFromList(null), [])
  assert.deepEqual(rolesFromList({}), [])
})

test('findRole matches by name case-insensitively', () => {
  const roles: Role[] = [{ id: '9', name: 'SOC Analyst', capabilities: [] }]
  assert.equal(findRole(roles, 'soc analyst')?.id, '9')
  assert.equal(findRole(roles, 'missing'), null)
  assert.equal(findRole(roles, ''), null)
})
