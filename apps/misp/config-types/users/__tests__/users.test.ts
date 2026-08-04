import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildUserFields, findUser, usersFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  email: 'analyst@example.com',
  org_id: 1,
  role_id: 3,
  disabled: 'no',
  change_pw: 'yes',
  termsaccepted: 'no',
  notify: 'no',
  external_auth_required: 'no',
  autoalert: 'no',
  contactalert: 'no',
  notification_daily: 'no',
  notification_weekly: 'no',
  notification_monthly: 'no',
}

test('validate rejects a missing email', async () => {
  const res = await validate(ctxOf([{ ...good, email: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL'))
})

test('validate rejects a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate rejects a non-positive org_id', async () => {
  const res = await validate(ctxOf([{ ...good, org_id: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ORG_ID'))
})

test('validate rejects a non-positive role_id', async () => {
  const res = await validate(ctxOf([{ ...good, role_id: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLE_ID'))
})

test('validate accepts a fully-populated user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate warns on a duplicate email', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EMAIL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildUserFields never includes password or authkey', () => {
  const fields = buildUserFields(good)
  assert.equal('password' in fields, false)
  assert.equal('authkey' in fields, false)
  assert.equal('confirm_password' in fields, false)
  assert.equal('external_auth_key' in fields, false)
})

test('buildUserFields maps org_id/role_id to numbers', () => {
  const fields = buildUserFields(good)
  assert.equal(fields.org_id, 1)
  assert.equal(fields.role_id, 3)
})

test('findUser matches case-insensitively', () => {
  const users = usersFromList([{ User: { id: 1, email: 'Analyst@Example.com' } }])
  assert.ok(findUser(users, 'analyst@example.com'))
  assert.equal(findUser(users, 'nobody@example.com'), null)
})
