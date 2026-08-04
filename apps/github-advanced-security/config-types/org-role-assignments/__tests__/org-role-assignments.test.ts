import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, findRoleByName, teamIsAssigned } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.team ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { org: 'octo-org', team: 'security-team', role_name: 'security_manager' }

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing org / team / role name', async () => {
  const res = await validate(ctxOf([{ org: '', team: '', role_name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORG'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE_NAME'))
})

test('validate accepts a good assignment', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate assignment', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ASSIGNMENT'))
})

// --- _shared ----------------------------------------------------------------

test('desiredFromItem reads identity fields', () => {
  const d = desiredFromItem(good)
  assert.equal(d.org, 'octo-org')
  assert.equal(d.team, 'security-team')
  assert.equal(d.roleName, 'security_manager')
})

test('findRoleByName matches case-insensitively', () => {
  const roles = [{ id: 1, name: 'security_manager', source: 'Predefined' }, { id: 2, name: 'Custom Role' }]
  assert.equal(findRoleByName(roles, 'Security_Manager')?.id, 1)
  assert.equal(findRoleByName(roles, 'custom role')?.id, 2)
  assert.equal(findRoleByName(roles, 'nope'), undefined)
})

test('teamIsAssigned matches case-insensitively', () => {
  const teams = [{ slug: 'Security-Team' }]
  assert.equal(teamIsAssigned(teams, 'security-team'), true)
  assert.equal(teamIsAssigned(teams, 'other-team'), false)
})
