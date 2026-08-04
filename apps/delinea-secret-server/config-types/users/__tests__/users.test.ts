import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractUserSpecs,
  findUserByUsername,
  userIdOf,
  usernameOf,
  isDirectoryUser,
  buildUserUpdateBody,
  buildUserRestoreBody,
  type LiveUser,
} from '../_shared'
import { recordsFromResponse } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.username ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { username: 'jdoe', displayName: 'Jane Doe', emailAddress: 'jane@example.com', enabled: true, isApplicationAccount: false, comment: 'analyst' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing username', async () => {
  const res = await validate(ctxOf([{ ...good, username: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_USERNAME'))
})

test('validate rejects a missing display name', async () => {
  const res = await validate(ctxOf([{ ...good, displayName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DISPLAY_NAME'))
})

test('validate accepts a good user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a suspect email address', async () => {
  const res = await validate(ctxOf([{ ...good, emailAddress: 'not-an-email' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_EMAIL'))
})

test('validate warns on a duplicate username', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_USER'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate never accepts a password field — the canvas schema declares none', async () => {
  const res = await validate(ctxOf([{ ...good, password: 'hunter2' }]))
  // No validation rule reads or reports on `password` — the field simply does not exist on this canvas.
  assert.equal(res.valid, true)
})

// --- _shared helpers --------------------------------------------------------

test('extractUserSpecs maps and trims canvas fields, and never carries a password', () => {
  const specs = extractUserSpecs(toItems([{ username: '  jdoe  ', displayName: ' Jane Doe ', emailAddress: ' jane@example.com ' }]))
  assert.equal(specs[0].username, 'jdoe')
  assert.equal(specs[0].displayName, 'Jane Doe')
  assert.equal(specs[0].emailAddress, 'jane@example.com')
  assert.equal('password' in specs[0], false)
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LiveUser>(JSON.stringify({ records: [{ id: 1, userName: 'jdoe' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
})

test('usernameOf reads the username', () => {
  assert.equal(usernameOf({ userName: 'jdoe' }), 'jdoe')
  assert.equal(usernameOf({}), '')
})

test('findUserByUsername matches case-insensitively on the exact username', () => {
  const users: LiveUser[] = [
    { id: 1, userName: 'jdoe' },
    { id: 2, userName: 'asmith' },
  ]
  assert.equal(findUserByUsername(users, 'JDOE')?.id, 1)
  assert.equal(findUserByUsername(users, 'asmith')?.id, 2)
  assert.equal(findUserByUsername(users, 'nope'), null)
})

test('userIdOf reads numeric ids and rejects blanks', () => {
  assert.equal(userIdOf({ id: 8 }), 8)
  assert.equal(userIdOf({ id: '3' }), 3)
  assert.equal(userIdOf({}), null)
})

test('isDirectoryUser flags a positive domainId as directory-managed', () => {
  assert.equal(isDirectoryUser({ domainId: 4 }), true)
  assert.equal(isDirectoryUser({ domainId: -1 }), false)
  assert.equal(isDirectoryUser({ domainId: 0 }), false)
  assert.equal(isDirectoryUser({}), false)
})

test('buildUserUpdateBody overlays managed fields on the full live object, preserving unmanaged fields', () => {
  const spec = extractUserSpecs(toItems([good]))[0]
  const existing: LiveUser = { id: 42, userName: 'jdoe', displayName: 'Old Name', domainId: -1, adGuid: undefined, someOtherField: 'keep-me' }
  const body = buildUserUpdateBody(spec, existing)
  assert.equal(body.id, 42)
  assert.equal(body.displayName, 'Jane Doe')
  assert.equal(body.emailAddress, 'jane@example.com')
  assert.equal(body.enabled, true)
  assert.equal(body.isApplicationAccount, false)
  assert.equal(body.someOtherField, 'keep-me')
  assert.equal('password' in body, false)
})

test('buildUserRestoreBody restores the exact prior full object', () => {
  const prior: LiveUser = { id: 42, userName: 'jdoe', displayName: 'Old Name', enabled: false }
  const body = buildUserRestoreBody(prior)
  assert.deepEqual(body, prior)
})
