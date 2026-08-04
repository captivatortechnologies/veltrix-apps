import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseText,
  parseBool,
  parsePermissions,
  buildDataScopeRestriction,
  buildRoleBody,
  buildRestoreBody,
  rolesFromResponse,
  roleId,
  findRole,
  findRoleByName,
  updateRoleResource,
  deleteRoleResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Auditors', permissions: '{"assets_devices":{"View":true}}', data_scope_enabled: false, data_scope_name: '' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects invalid permissions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PERMISSIONS'))
})

test('validate warns on an empty permission set', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: '{}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_PERMISSIONS'))
})

test('validate requires a data-scope name when the restriction is enabled', async () => {
  const res = await validate(ctxOf([{ ...good, data_scope_enabled: true, data_scope_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_DATA_SCOPE_NAME'))
})

test('validate accepts a data-scope restriction with a name', async () => {
  const res = await validate(ctxOf([{ ...good, data_scope_enabled: true, data_scope_name: 'Contractors' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- field parsing ------------------------------------------------------------

test('parseBool accepts real booleans and the string "true"', () => {
  assert.equal(parseBool(true), true)
  assert.equal(parseBool('true'), true)
  assert.equal(parseBool('false'), false)
  assert.equal(parseBool(undefined), false)
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
})

// --- body building --------------------------------------------------------

test('buildDataScopeRestriction nulls the data_scope when disabled', () => {
  assert.deepEqual(buildDataScopeRestriction(false, 'ds-uuid'), { enabled: false, data_scope: null })
  assert.deepEqual(buildDataScopeRestriction(true, 'ds-uuid'), { enabled: true, data_scope: 'ds-uuid' })
})

test('buildRoleBody produces a roles_schema body with no uuid', () => {
  const body = buildRoleBody({ name: 'n', permissions: { a: true }, dataScopeRestriction: { enabled: false, data_scope: null } })
  assert.equal(body.data.type, 'roles_schema')
  assert.equal('uuid' in body.data.attributes, false)
  assert.deepEqual(body.data.attributes.permissions, { a: true })
})

test('buildRestoreBody wraps prior attributes verbatim', () => {
  const body = buildRestoreBody({ name: 'n', permissions: { a: true }, data_scope_restriction: { enabled: true, data_scope: 'x' } })
  assert.deepEqual(body.data.attributes.data_scope_restriction, { enabled: true, data_scope: 'x' })
})

// --- response unwrapping + identity -----------------------------------------

const listResponse = {
  data: [
    { id: 'role-1', type: 'roles_details_schema', attributes: { uuid: 'role-1', name: 'Auditors', permissions: {}, predefined: false } },
    { id: 'role-2', type: 'roles_details_schema', attributes: { uuid: 'role-2', name: 'Admin', permissions: {}, predefined: true } },
  ],
}

test('rolesFromResponse flattens JSON:API rows', () => {
  const rows = rolesFromResponse(listResponse)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Auditors')
  assert.equal(roleId(rows[0]), 'role-1')
})

test('findRole ignores predefined roles', () => {
  const rows = rolesFromResponse(listResponse)
  assert.equal(roleId(findRole(rows, 'Auditors')), 'role-1')
  assert.equal(findRole(rows, 'Admin'), null) // predefined skipped
})

test('findRoleByName includes predefined roles', () => {
  const rows = rolesFromResponse(listResponse)
  assert.equal(roleId(findRoleByName(rows, 'Admin')), 'role-2')
})

// --- endpoint construction ---------------------------------------------------

test('role resource paths encode the uuid', () => {
  assert.equal(updateRoleResource('a b'), 'settings/roles/a%20b')
  assert.equal(deleteRoleResource('a b'), 'settings/roles/a%20b')
})
