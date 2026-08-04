import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseText,
  parseBool,
  isInternalUser,
  buildCreateBody,
  buildUpdateBody,
  buildRestoreBody,
  buildDeleteBody,
  usersFromResponse,
  userId,
  findUser,
  updateUserResource,
  deleteUserResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.user_name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { user_name: 'jdoe', role_name: 'Auditors', email: 'j@example.com' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing user_name', async () => {
  const res = await validate(ctxOf([{ ...good, user_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_USER_NAME'))
})

test('validate rejects a missing role_name', async () => {
  const res = await validate(ctxOf([{ ...good, role_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE_NAME'))
})

test('validate warns on a duplicate user_name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_USER_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- field parsing ------------------------------------------------------------

test('parseBool accepts real booleans and the string "true"', () => {
  assert.equal(parseBool(true), true)
  assert.equal(parseBool('true'), true)
  assert.equal(parseBool(undefined), false)
})

test('isInternalUser treats a blank or "internal" source as internal', () => {
  assert.equal(isInternalUser({ source: 'internal' }), true)
  assert.equal(isInternalUser({ source: '' }), true)
  assert.equal(isInternalUser({ source: undefined }), true)
  assert.equal(isInternalUser({ source: 'ldap' }), false)
  assert.equal(isInternalUser({ source: 'saml' }), false)
})

// --- body building --------------------------------------------------------

test('buildCreateBody always requests an auto-generated password, never a supplied one', () => {
  const body = buildCreateBody({ userName: 'jdoe', roleId: 'r1', email: '', firstName: '', lastName: '' })
  assert.equal(body.data.type, 'create_user_schema')
  assert.equal(body.data.attributes.auto_generated_password, true)
  assert.equal('password' in body.data.attributes, false)
})

test('buildUpdateBody never includes a password field', () => {
  const body = buildUpdateBody({
    userName: 'jdoe',
    roleId: 'r1',
    email: '',
    firstName: '',
    lastName: '',
    title: '',
    department: '',
    ignoreRoleAssignmentRules: false,
  })
  assert.equal(body.data.type, 'users_schema')
  assert.equal('password' in body.data.attributes, false)
})

test('buildRestoreBody wraps prior attributes verbatim (still no password)', () => {
  const body = buildRestoreBody({ user_name: 'jdoe', role_id: 'r1', email: 'e', ignore_role_assignment_rules: true })
  assert.equal(body.data.attributes.ignore_role_assignment_rules, true)
  assert.equal('password' in body.data.attributes, false)
})

test('buildDeleteBody uses the base_schema type (inherited default — see _shared.ts)', () => {
  const body = buildDeleteBody('u1')
  assert.equal(body.data.type, 'base_schema')
  assert.equal(body.data.attributes.uuid, 'u1')
})

// --- response unwrapping + identity -----------------------------------------

const listResponse = {
  data: [
    { id: 'user-1', type: 'users_details_schema', attributes: { uuid: 'user-1', user_name: 'jdoe', source: 'internal', role_name: 'Auditors' } },
    { id: 'user-2', type: 'users_details_schema', attributes: { uuid: 'user-2', user_name: 'jdoe', source: 'ldap', role_name: 'Viewer' } },
  ],
}

test('usersFromResponse flattens JSON:API rows', () => {
  const rows = usersFromResponse(listResponse)
  assert.equal(rows.length, 2)
  assert.equal(userId(rows[0]), 'user-1')
})

test('findUser only matches the internal account, ignoring an LDAP account with the same user_name', () => {
  const rows = usersFromResponse(listResponse)
  const match = findUser(rows, 'jdoe')
  assert.equal(userId(match), 'user-1')
})

test('findUser returns null when only a non-internal account matches', () => {
  const rows = usersFromResponse([{ id: 'user-3', attributes: { uuid: 'user-3', user_name: 'ssoonly', source: 'saml' } }])
  assert.equal(findUser(rows, 'ssoonly'), null)
})

// --- endpoint construction ---------------------------------------------------

test('user resource paths encode the uuid', () => {
  assert.equal(updateUserResource('a b'), 'settings/users/a%20b')
  assert.equal(deleteUserResource('a b'), 'settings/users/a%20b')
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
})
