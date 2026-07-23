// ============================================================================
// deploy-api tests — the pure resolvers used by `veltrix deploy`: mapping an
// environment name (or Tag id) to a Tag id, and approver emails (or ids) to
// user ids. These run before any network call, so a bad ref fails fast with a
// clear message instead of a confusing server error.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnvironmentId, resolveApproverIds } from '../src/lib/deploy-api.mjs'

const ENVS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'LocalBabong' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Production' },
]
const USERS = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'lead@example.com' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'ops@example.com' },
]

test('resolveEnvironmentId matches by name, case-insensitively', () => {
  assert.equal(resolveEnvironmentId('LocalBabong', ENVS), ENVS[0].id)
  assert.equal(resolveEnvironmentId('localbabong', ENVS), ENVS[0].id)
})

test('resolveEnvironmentId passes a UUID through unchanged', () => {
  const raw = '99999999-9999-4999-8999-999999999999'
  assert.equal(resolveEnvironmentId(raw, ENVS), raw)
})

test('resolveEnvironmentId returns null for an unknown name', () => {
  assert.equal(resolveEnvironmentId('Nope', ENVS), null)
})

test('resolveApproverIds maps emails to ids and passes UUIDs through', () => {
  const raw = '33333333-3333-4333-8333-333333333333'
  const { ids, unresolved } = resolveApproverIds(['lead@example.com', raw], USERS)
  assert.deepEqual(ids, [USERS[0].id, raw])
  assert.deepEqual(unresolved, [])
})

test('resolveApproverIds reports unresolved emails', () => {
  const { ids, unresolved } = resolveApproverIds(['ghost@example.com', 'ops@example.com'], USERS)
  assert.deepEqual(ids, [USERS[1].id])
  assert.deepEqual(unresolved, ['ghost@example.com'])
})
