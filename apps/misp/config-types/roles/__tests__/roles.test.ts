import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRoleFields, findRole, rolesFromList, PERM_FIELDS } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function baseFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: 'Analyst' }
  for (const perm of PERM_FIELDS) fields[perm] = 'no'
  fields.default_role = 'no'
  fields.restricted_to_site_admin = 'no'
  fields.enforce_rate_limit = 'no'
  fields.rate_limit_count = 0
  fields.memory_limit = ''
  fields.max_execution_time = ''
  return { ...fields, ...overrides }
}

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([baseFields({ name: '' })]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a fully-populated role', async () => {
  const res = await validate(ctxOf([baseFields()]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects an invalid yes/no permission value', async () => {
  const res = await validate(ctxOf([baseFields({ perm_site_admin: 'maybe' })]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_YES_NO' && e.field.includes('perm_site_admin')))
})

test('validate rejects a negative rate_limit_count', async () => {
  const res = await validate(ctxOf([baseFields({ rate_limit_count: -5 })]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NUMBER'))
})

test('validate rejects a malformed memory_limit', async () => {
  const res = await validate(ctxOf([baseFields({ memory_limit: 'lots' })]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MEMORY_LIMIT'))
})

test('validate accepts -1 or a unit-suffixed memory_limit', async () => {
  for (const memory_limit of ['-1', '512M', '1G']) {
    const res = await validate(ctxOf([baseFields({ memory_limit })]))
    assert.equal(res.valid, true, `expected memory_limit=${memory_limit} to be valid`)
  }
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([baseFields(), baseFields()]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildRoleFields maps every perm field to a boolean', () => {
  const fields = buildRoleFields(baseFields({ perm_site_admin: 'yes' }))
  assert.equal(fields.perm_site_admin, true)
  assert.equal(fields.perm_admin, false)
  assert.equal(fields.name, 'Analyst')
})

test('findRole matches case-insensitively', () => {
  const roles = rolesFromList([{ Role: { id: 1, name: 'Analyst' } }])
  assert.ok(findRole(roles, 'analyst'))
  assert.equal(findRole(roles, 'admin'), null)
})
