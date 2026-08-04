import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRoleBody,
  extractRoleSpec,
  findRoleByName,
  missingPermissionIds,
  resolvePermissionIds,
  roleKey,
  toCreatePayload,
  toUpdatePayload,
  type PermissionRef,
  type RoleResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Security Read-Only', permissions: ['security_monitoring_rules_read', 'monitors_read'] }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.warnings.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns (does not error) on a role with no permissions', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_PERMISSIONS'))
})

test('validate rejects a duplicate role name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('roleKey normalizes case and whitespace', () => {
  assert.equal(roleKey('  Security Read-Only '), 'security read-only')
})

test('findRoleByName matches case-insensitively', () => {
  const roles: RoleResource[] = [{ id: 'r1', attributes: { name: 'Security Read-Only' } }]
  assert.equal(findRoleByName(roles, 'security read-only')?.id, 'r1')
  assert.equal(findRoleByName(roles, 'missing'), null)
})

test('buildRoleBody carries only the name', () => {
  const spec = extractRoleSpec(good)
  assert.deepEqual(buildRoleBody(spec), { name: good.name })
})

test('resolvePermissionIds resolves by name (case-insensitive) and by alias, and reports unknowns', () => {
  const all: PermissionRef[] = [
    { id: 'p1', name: 'monitors_write', aliases: [] },
    { id: 'p2', name: 'logs_write_pipelines', aliases: ['logs_write_pipeline'] },
  ]
  const resolved = resolvePermissionIds(all, ['Monitors_Write', 'logs_write_pipeline', 'made_up_permission'])
  assert.deepEqual(resolved.ids, ['p1', 'p2'])
  assert.deepEqual(resolved.unknown, ['made_up_permission'])
})

test('missingPermissionIds returns only declared ids not already present (additive-only, never a removal list)', () => {
  assert.deepEqual(missingPermissionIds(['p1', 'p2'], ['p2', 'p3']), ['p1'])
  assert.deepEqual(missingPermissionIds(['p1'], ['p1']), [])
})

test('toCreatePayload / toUpdatePayload wrap the body correctly', () => {
  const spec = extractRoleSpec(good)
  const body = buildRoleBody(spec)
  const created = toCreatePayload(body)
  assert.equal(created.data.type, 'roles')
  assert.equal('id' in created.data, false)

  const updated = toUpdatePayload('r1', body)
  assert.equal(updated.data.id, 'r1')
})
