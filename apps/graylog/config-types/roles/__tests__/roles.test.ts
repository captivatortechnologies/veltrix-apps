import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRoleBody, bodyFromLiveRole, parsePermissions, rolesFromList, findRole } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'SOC Analyst', description: 'Read-only SOC access', permissions: '["streams:read","dashboards:read"]' }

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

test('validate rejects the built-in Admin role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Admin' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'BUILT_IN_ROLE'))
})

test('validate rejects malformed permissions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PERMISSIONS_JSON'))
})

test('validate warns on an empty permission set', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_PERMISSIONS'))
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

test('buildRoleBody always sends read_only: false', () => {
  const { body, error } = buildRoleBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.read_only, false)
  assert.deepEqual(body?.permissions, ['streams:read', 'dashboards:read'])
})

test('bodyFromLiveRole maps a live role back to a request body', () => {
  const body = bodyFromLiveRole({ name: 'x', permissions: ['a'], read_only: true })
  assert.equal(body.read_only, false)
  assert.deepEqual(body.permissions, ['a'])
})

test('parsePermissions treats blank as an empty array', () => {
  assert.deepEqual(parsePermissions('').permissions, [])
})

test('rolesFromList + findRole match by name from the API envelope', () => {
  const live = rolesFromList({ roles: [{ name: 'Admin', read_only: true }, { name: 'SOC Analyst' }], total: 2 })
  assert.equal(live.length, 2)
  assert.equal(findRole(live, 'SOC Analyst')?.name, 'SOC Analyst')
  assert.equal(findRole(live, 'nope'), null)
})
