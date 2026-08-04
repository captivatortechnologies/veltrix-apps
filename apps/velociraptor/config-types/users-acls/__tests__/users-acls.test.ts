import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  readUsers,
  findUser,
  parseRoles,
  parsePermissions,
  buildPolicyDelta,
  userCreateVQL,
  userGrantVQL,
  userGrantPolicyVQL,
  userDeleteVQL,
  GUI_USERS_VQL,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'analyst@example.com', roles: 'reader, analyst', password: '' }

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires at least one role', async () => {
  const res = await validate(ctxOf([{ ...good, roles: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLES'))
})

test('validate warns on an unknown role', async () => {
  const res = await validate(ctxOf([{ ...good, roles: 'reader, wizard' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_ROLE'))
})

test('validate warns on a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Analyst@Example.com' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an authored password shorter than the minimum length', async () => {
  const res = await validate(ctxOf([{ ...good, password: 'short1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'WEAK_PASSWORD'))
})

test('validate accepts an authored password at or above the minimum length', async () => {
  const res = await validate(ctxOf([{ ...good, password: 'longenoughpw' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.some((e) => e.code === 'WEAK_PASSWORD'), false)
})

test('validate does not require a password (SSO users leave it blank)', async () => {
  const res = await validate(ctxOf([{ ...good, password: '' }]))
  assert.equal(res.errors.some((e) => e.code === 'WEAK_PASSWORD'), false)
})

test('validate warns on an unknown custom permission', async () => {
  const res = await validate(ctxOf([{ ...good, customPermissions: 'execve, made_up_permission' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_PERMISSION'))
})

test('validate does not warn when custom permissions are all well-known', async () => {
  const res = await validate(ctxOf([{ ...good, customPermissions: 'execve, filesystem_read' }]))
  assert.equal(res.warnings.some((w) => w.code === 'UNKNOWN_PERMISSION'), false)
})

test('validate is silent on custom permissions when the field is blank (optional)', async () => {
  const res = await validate(ctxOf([{ ...good, customPermissions: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.some((w) => w.code === 'UNKNOWN_PERMISSION'), false)
})

// --- helpers ------------------------------------------------------------------

test('parseRoles splits CSV roles', () => {
  assert.deepEqual(parseRoles('reader, analyst,investigator'), ['reader', 'analyst', 'investigator'])
})

test('readUsers reads name + roles tolerant of casing and array/CSV', () => {
  const users = readUsers([
    { name: 'a@x.com', roles: ['reader', 'analyst'] },
    { Name: 'b@x.com', Roles: 'administrator' },
    { name: '' },
  ])
  assert.equal(users.length, 2)
  assert.deepEqual(users[0], { name: 'a@x.com', roles: ['reader', 'analyst'], permissions: null })
  assert.deepEqual(users[1], { name: 'b@x.com', roles: ['administrator'], permissions: null })
})

test('readUsers reads permissions from a policy dict, keeping only the true keys', () => {
  const users = readUsers([{ name: 'a@x.com', roles: [], policy: { execve: true, filesystem_read: true, network: false } }])
  assert.deepEqual(users[0].permissions, ['execve', 'filesystem_read'])
})

test('readUsers treats an absent policy dict as null (unknown), not empty', () => {
  const users = readUsers([{ name: 'a@x.com', roles: [] }])
  assert.equal(users[0].permissions, null)
})

test('findUser matches by case-insensitive name', () => {
  const live = readUsers([{ name: 'A@X.com', roles: ['reader'] }])
  assert.equal(findUser(live, 'a@x.com')?.name, 'A@X.com')
  assert.equal(findUser(live, 'missing'), null)
})

// --- VQL builders -------------------------------------------------------------

test('userCreateVQL renders roles as a VQL array and includes a password when given', () => {
  const vql = userCreateVQL('a@x.com', ['reader', 'analyst'], 'secret')
  assert.match(vql, /user_create\(user='a@x\.com', roles=\['reader', 'analyst'\], password='secret'\)/)
})

test('userCreateVQL omits the password argument when none is given', () => {
  const vql = userCreateVQL('a@x.com', ['reader'])
  assert.match(vql, /user_create\(user='a@x\.com', roles=\['reader'\]\)/)
  assert.ok(!/password=/.test(vql))
})

test('userGrantVQL / userDeleteVQL name the user', () => {
  assert.match(userGrantVQL('a@x.com', ['reader']), /user_grant\(user='a@x\.com', roles=\['reader'\]\)/)
  assert.match(userDeleteVQL('a@x.com'), /user_delete\(user='a@x\.com'\)/)
})

test('userCreateVQL escapes single quotes in inputs', () => {
  const vql = userCreateVQL("o'brien", ['reader'], "pa'ss")
  assert.match(vql, /user='o''brien'/)
  assert.match(vql, /password='pa''ss'/)
})

test('GUI_USERS_VQL selects from gui_users()', () => {
  assert.match(GUI_USERS_VQL, /FROM gui_users\(\)/)
})

test('userGrantPolicyVQL wraps the policy dict in parse_json + user_grant', () => {
  const vql = userGrantPolicyVQL('a@x.com', { execve: true, network: false })
  assert.match(vql, /user_grant\(user='a@x\.com', policy=parse_json\(data='/)
})

test('parsePermissions splits CSV permissions the same way parseRoles does', () => {
  assert.deepEqual(parsePermissions('execve, filesystem_read,network'), ['execve', 'filesystem_read', 'network'])
})

// --- buildPolicyDelta -----------------------------------------------------------

test('buildPolicyDelta grants every desired permission', () => {
  assert.deepEqual(buildPolicyDelta(['execve', 'network'], null), { execve: true, network: true })
})

test('buildPolicyDelta explicitly clears a prior permission no longer desired', () => {
  assert.deepEqual(buildPolicyDelta(['execve'], ['execve', 'network']), { execve: true, network: false })
})

test('buildPolicyDelta is empty when nothing is desired and nothing prior is known', () => {
  assert.deepEqual(buildPolicyDelta([], null), {})
})

test('buildPolicyDelta clears everything prior when nothing is desired anymore', () => {
  assert.deepEqual(buildPolicyDelta([], ['execve', 'network']), { execve: false, network: false })
})
