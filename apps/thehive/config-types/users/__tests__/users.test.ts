import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildUserCreateBody,
  buildUserUpdateBody,
  toUserUpdate,
  findUser,
  userId,
  normalizeLogin,
  usersFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the TheHive REST API (node:https inside
 * thehiveApi), impractical to mock here. Tests cover validate.ts and the pure
 * network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.login ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { login: 'jane@corp.test', name: 'Jane Analyst', profile: 'analyst', email: 'jane@corp.test', organisation: 'SOC' }

test('validate rejects a missing login', async () => {
  const res = await validate(ctxOf([{ ...good, login: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LOGIN'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing profile', async () => {
  const res = await validate(ctxOf([{ ...good, profile: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROFILE'))
})

test('validate warns on a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'INVALID_EMAIL'))
})

test('validate warns on a duplicate login (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, login: 'JANE@CORP.TEST' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_LOGIN'))
})

test('validate accepts a good user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeLogin trims and lowercases', () => {
  assert.equal(normalizeLogin('  JANE@Corp.Test '), 'jane@corp.test')
  assert.equal(normalizeLogin(undefined), '')
})

test('buildUserCreateBody lowercases login and omits blank optionals', () => {
  const body = buildUserCreateBody({ login: 'JANE@corp.test', name: 'Jane', profile: 'analyst' })
  assert.equal(body.login, 'jane@corp.test')
  assert.equal(body.name, 'Jane')
  assert.equal(body.profile, 'analyst')
  assert.ok(!('email' in body))
  assert.ok(!('organisation' in body))
})

test('buildUserUpdateBody carries name/profile and present optionals but not login', () => {
  const body = buildUserUpdateBody(good)
  assert.ok(!('login' in body))
  assert.equal(body.name, 'Jane Analyst')
  assert.equal(body.profile, 'analyst')
  assert.equal(body.organisation, 'SOC')
})

test('toUserUpdate maps a live user to its mutable subset', () => {
  const body = toUserUpdate({ login: 'x', name: 'X', profile: 'read-only', organisation: 'SOC', _id: 'abc' })
  assert.deepEqual(body, { name: 'X', profile: 'read-only', organisation: 'SOC' })
})

test('findUser matches by login case-insensitively; userId prefers _id then id', () => {
  const live = [{ _id: 'abc', login: 'jane@corp.test' }, { id: 5, login: 'bob@corp.test' }]
  assert.equal(userId(findUser(live, 'JANE@corp.test')), 'abc')
  assert.equal(userId(findUser(live, 'bob@corp.test')), '5')
  assert.equal(findUser(live, 'nope@corp.test'), null)
})

test('usersFromList unwraps arrays and wrapped rows', () => {
  assert.equal(usersFromList([{ login: 'a' }]).length, 1)
  assert.equal(usersFromList({ data: [{ login: 'a' }] }).length, 1)
  assert.equal(usersFromList(null).length, 0)
})
