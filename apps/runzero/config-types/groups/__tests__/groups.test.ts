import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildGroupPost,
  buildGroupPut,
  buildGroupPutFromPrior,
  findGroup,
  readOrgRoles,
  orgRolesEqual,
  parseExpiresAt,
  type RunzeroGroup,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Viewers', description: 'Read-only access', orgDefaultRole: 'viewer' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on an unparseable expiry', async () => {
  const res = await validate(ctxOf([{ ...good, expiresAt: 'not a date' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNPARSEABLE_EXPIRY'))
})

test('validate accepts an ISO date expiry', async () => {
  const res = await validate(ctxOf([{ ...good, expiresAt: '2027-01-01' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'UNPARSEABLE_EXPIRY'))
})

test('validate warns on an unrecognized role', async () => {
  const res = await validate(ctxOf([{ ...good, orgDefaultRole: 'megaadmin' }]))
  assert.ok(res.warnings.some((w) => w.code === 'UNRECOGNIZED_ROLE'))
})

// --- _shared helpers ------------------------------------------------------

test('parseExpiresAt accepts epoch seconds and ISO dates, rejects garbage', () => {
  assert.equal(parseExpiresAt('1735689600'), 1735689600)
  assert.equal(typeof parseExpiresAt('2027-01-01'), 'number')
  assert.equal(parseExpiresAt('not a date'), undefined)
  assert.equal(parseExpiresAt(''), undefined)
})

test('readOrgRoles and orgRolesEqual behave like the Users config type', () => {
  assert.deepEqual(readOrgRoles([{ key: 'org-1', value: 'admin' }]), { 'org-1': 'admin' })
  assert.equal(orgRolesEqual({ a: 'admin' }, { a: 'admin' }), true)
  assert.equal(orgRolesEqual({ a: 'admin' }, { a: 'viewer' }), false)
})

test('buildGroupPost maps fields and includes expires_at only when parseable', () => {
  const post = buildGroupPost({ name: ' Viewers ', description: 'd', orgDefaultRole: 'viewer', expiresAt: '1735689600' })
  assert.deepEqual(post, { name: 'Viewers', description: 'd', org_default_role: 'viewer', org_roles: {}, expires_at: 1735689600 })
  const noExpiry = buildGroupPost({ name: 'Viewers' })
  assert.ok(!('expires_at' in noExpiry))
})

test('buildGroupPut embeds the id', () => {
  const put = buildGroupPut('g-1', { name: 'Viewers' })
  assert.equal(put.id, 'g-1')
  assert.equal(put.name, 'Viewers')
})

test('buildGroupPutFromPrior restores a recorded group', () => {
  const prior: RunzeroGroup = { id: 'g-1', name: 'Viewers', description: 'd', org_default_role: 'viewer', org_roles: { 'org-1': 'admin' }, expires_at: 123 }
  const put = buildGroupPutFromPrior('g-1', prior)
  assert.equal(put.name, 'Viewers')
  assert.deepEqual(put.org_roles, { 'org-1': 'admin' })
  assert.equal(put.expires_at, 123)
})

test('findGroup matches by name case-insensitively', () => {
  const groups = [{ id: '1', name: 'Viewers' }, { id: '2', name: 'Admins' }]
  assert.equal(findGroup(groups, 'viewers')?.id, '1')
  assert.equal(findGroup(groups, 'ADMINS')?.id, '2')
  assert.equal(findGroup(groups, 'nope'), null)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})
