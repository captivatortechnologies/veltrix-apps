import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateRoleCommand, buildModifyRoleCommand, buildDeleteRoleCommand, parseRoles, PREDEFINED_ROLES } from '../../../lib/gmp/roles'
import { buildRoleInput, findRoleByName } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'SCAP Observer', users: ['sarah', 'bob'] }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a predefined role name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Admin' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'PREDEFINED_ROLE'))
})

test('validate warns on a duplicate role name', async () => {
  const res = await validate(ctxOf([good, { ...good, users: ['bob'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- predefined role table ---------------------------------------------------

test('PREDEFINED_ROLES has exactly 7 entries with stable UUIDs', () => {
  assert.equal(PREDEFINED_ROLES.length, 7)
  assert.ok(PREDEFINED_ROLES.some((r) => r.name === 'Admin' && r.id === '7a8cb5b4-b74d-11e2-8187-406186ea4fc5'))
  assert.ok(PREDEFINED_ROLES.some((r) => r.name === 'Super Admin'))
})

// --- command builders --------------------------------------------------------

test('buildCreateRoleCommand emits name, comment and users', () => {
  const xml = buildCreateRoleCommand({ name: 'SCAP Observer', comment: 'read-only', users: ['sarah', 'bob'] })
  assert.ok(xml.includes('<name>SCAP Observer</name>'))
  assert.ok(xml.includes('<comment>read-only</comment>'))
  assert.ok(xml.includes('<users>sarah, bob</users>'))
})

test('buildModifyRoleCommand targets by role_id', () => {
  const xml = buildModifyRoleCommand('r1', { name: 'Renamed' })
  assert.equal(xml, '<modify_role role_id="r1"><name>Renamed</name></modify_role>')
})

test('buildDeleteRoleCommand sets ultimate', () => {
  assert.equal(buildDeleteRoleCommand('r1', true), '<delete_role role_id="r1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseRoles extracts users list', () => {
  const xml = '<get_roles_response><role id="r1"><name>SCAP Observer</name><users>sarah, bob</users></role></get_roles_response>'
  const [r] = parseRoles(xml)
  assert.deepEqual(r.users, ['sarah', 'bob'])
})

// --- _shared helpers -----------------------------------------------------------

test('findRoleByName excludes predefined roles even if the id matches', () => {
  const roles = parseRoles('<get_roles_response><role id="7a8cb5b4-b74d-11e2-8187-406186ea4fc5"><name>Admin</name></role></get_roles_response>')
  assert.equal(findRoleByName(roles, 'Admin'), null)
})

test('findRoleByName matches a custom role by trimmed name', () => {
  const roles = parseRoles('<get_roles_response><role id="r1"><name>SCAP Observer</name></role></get_roles_response>')
  assert.equal(findRoleByName(roles, 'SCAP Observer')?.id, 'r1')
})

test('buildRoleInput accepts a comma-separated users string too', () => {
  const input = buildRoleInput({ name: 'SCAP Observer', users: 'sarah, bob' })
  assert.deepEqual(input.users, ['sarah', 'bob'])
})
