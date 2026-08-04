import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCustomRoleBody, customRoleFromEnvelope } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'custom_role_1',
  description: 'simple role with 2 permissions',
  permissionGroups: ['assets.asset.read', 'auth.tokens.write'],
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects no permission groups', async () => {
  const res = await validate(ctxOf([{ ...good, permissionGroups: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PERMISSIONS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildCustomRoleBody maps canvas fields and only sets id when given', () => {
  const created = buildCustomRoleBody(good)
  assert.equal(created.name, good.name)
  assert.deepEqual(created.permission_groups, good.permissionGroups)
  assert.equal(created.id, undefined)

  const updated = buildCustomRoleBody(good, 'role-123')
  assert.equal(updated.id, 'role-123')
})

test('customRoleFromEnvelope unwraps the { data: {...} } envelope', () => {
  assert.deepEqual(customRoleFromEnvelope({ data: { id: 'r1', name: 'x' } }), { id: 'r1', name: 'x' })
  assert.equal(customRoleFromEnvelope(null), null)
})
