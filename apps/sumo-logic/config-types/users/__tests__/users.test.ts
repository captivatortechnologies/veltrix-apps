import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildUserCreateBody, buildUserUpdateBody, findUserByEmail, normalizeActive, toStringList, usersFromList, type SumoUser } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { email: 'analyst@example.com', firstName: 'Ana', lastName: 'Lyst', roleIds: ['00000000000001DF'], isActive: true }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing/invalid email', async () => {
  assert.ok((await validate(ctxOf([{ ...good, email: '' }]))).errors.some((e) => e.code === 'EMPTY_EMAIL'))
  assert.ok((await validate(ctxOf([{ ...good, email: 'not-an-email' }]))).errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate rejects a missing first name', async () => {
  const res = await validate(ctxOf([{ ...good, firstName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FIRST_NAME'))
})

test('validate warns on a user with no roles', async () => {
  const res = await validate(ctxOf([{ ...good, roleIds: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_ROLES'))
})

test('validate warns on a duplicate email', async () => {
  const res = await validate(ctxOf([good, { ...good, firstName: 'Other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EMAIL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeActive defaults to true when unset', () => {
  assert.equal(normalizeActive(undefined), true)
  assert.equal(normalizeActive(false), false)
  assert.equal(normalizeActive('no'), false)
})

test('toStringList accepts arrays and comma strings, trims and de-dupes', () => {
  assert.deepEqual(toStringList(['a', ' b ', 'a']), ['a', 'b'])
  assert.deepEqual(toStringList('a, b ,,a'), ['a', 'b'])
})

test('buildUserCreateBody includes email; update body omits it', () => {
  const created = buildUserCreateBody(good)
  assert.equal(created.email, 'analyst@example.com')
  const updated = buildUserUpdateBody(good)
  assert.equal('email' in updated, false)
})

test('usersFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const users: SumoUser[] = [{ id: '1', firstName: 'A', lastName: 'B', email: 'a@b.com', roleIds: [] }]
  assert.deepEqual(usersFromList({ data: users }), users)
  assert.deepEqual(usersFromList(users), users)
  assert.deepEqual(usersFromList(null), [])
})

test('findUserByEmail matches by email case-insensitively', () => {
  const users: SumoUser[] = [{ id: '9', firstName: 'A', lastName: 'B', email: 'Analyst@Example.com', roleIds: [] }]
  assert.equal(findUserByEmail(users, 'analyst@example.com')?.id, '9')
  assert.equal(findUserByEmail(users, 'missing@example.com'), null)
})
