import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildUserOptions,
  buildUserInviteOptions,
  buildUserOptionsFromPrior,
  findUser,
  readOrgRoles,
  orgRolesEqual,
  wantsInvite,
  type RunzeroUser,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { email: 'jsmith@example.com', firstName: 'James', lastName: 'Smith', orgDefaultRole: 'viewer' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing email', async () => {
  const res = await validate(ctxOf([{ ...good, email: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a suspect email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_EMAIL'))
})

test('validate warns on a duplicate email', async () => {
  const res = await validate(ctxOf([good, { ...good, firstName: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EMAIL'))
})

test('validate warns when client admin is granted', async () => {
  const res = await validate(ctxOf([{ ...good, clientAdmin: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'CLIENT_ADMIN_GRANTED'))
})

test('validate warns on an unrecognized default role', async () => {
  const res = await validate(ctxOf([{ ...good, orgDefaultRole: 'superduperadmin' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNRECOGNIZED_ROLE'))
})

test('validate accepts a known role without warning', async () => {
  const res = await validate(ctxOf([{ ...good, orgDefaultRole: 'admin' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'UNRECOGNIZED_ROLE'))
})

// --- _shared helpers ------------------------------------------------------

test('readOrgRoles handles row arrays, object maps and key=value strings', () => {
  assert.deepEqual(readOrgRoles([{ key: 'org-1', value: 'admin' }]), { 'org-1': 'admin' })
  assert.deepEqual(readOrgRoles({ 'org-1': 'viewer' }), { 'org-1': 'viewer' })
  assert.deepEqual(readOrgRoles('org-1=admin\norg-2=viewer'), { 'org-1': 'admin', 'org-2': 'viewer' })
  assert.deepEqual(readOrgRoles(''), {})
})

test('orgRolesEqual is a set-based map comparison', () => {
  assert.equal(orgRolesEqual({ a: 'admin', b: 'viewer' }, { b: 'viewer', a: 'admin' }), true)
  assert.equal(orgRolesEqual({ a: 'admin' }, { a: 'viewer' }), false)
})

test('wantsInvite defaults to true and honors an explicit false', () => {
  assert.equal(wantsInvite({}), true)
  assert.equal(wantsInvite({ sendInvite: true }), true)
  assert.equal(wantsInvite({ sendInvite: false }), false)
})

test('buildUserOptions maps fields into the UserOptions shape', () => {
  const opts = buildUserOptions({ email: ' jsmith@example.com ', firstName: 'James', lastName: 'Smith', clientAdmin: true, orgDefaultRole: 'admin' })
  assert.deepEqual(opts, {
    first_name: 'James',
    last_name: 'Smith',
    email: 'jsmith@example.com',
    client_admin: true,
    org_default_role: 'admin',
    org_roles: {},
  })
})

test('buildUserInviteOptions adds subject/message only when set', () => {
  const opts = buildUserInviteOptions({ email: 'a@b.com', inviteSubject: 'Welcome', inviteMessage: 'Hi!' })
  assert.equal(opts.subject, 'Welcome')
  assert.equal(opts.message, 'Hi!')
  const bare = buildUserInviteOptions({ email: 'a@b.com' })
  assert.ok(!('subject' in bare))
  assert.ok(!('message' in bare))
})

test('buildUserOptionsFromPrior restores a recorded user', () => {
  const prior: RunzeroUser = { id: 'u-1', email: 'a@b.com', first_name: 'A', last_name: 'B', client_admin: false, org_default_role: 'viewer', org_roles: { 'org-1': 'admin' } }
  const opts = buildUserOptionsFromPrior(prior)
  assert.equal(opts.email, 'a@b.com')
  assert.deepEqual(opts.org_roles, { 'org-1': 'admin' })
})

test('findUser matches by email case-insensitively', () => {
  const users = [{ id: '1', email: 'JSmith@Example.com' }, { id: '2', email: 'other@example.com' }]
  assert.equal(findUser(users, 'jsmith@example.com')?.id, '1')
  assert.equal(findUser(users, 'OTHER@EXAMPLE.COM')?.id, '2')
  assert.equal(findUser(users, 'nope@example.com'), null)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})
