import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readOptionalInt,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikLDAPProvider,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const AUTHZ_FLOW = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const INVAL_FLOW = 'b2c3d4e5-f6a7-4890-b123-456789abcdef'

const good = {
  name: 'Corp LDAP',
  authorization_flow: AUTHZ_FLOW,
  invalidation_flow: INVAL_FLOW,
  base_dn: 'DC=ldap,DC=example,DC=com',
  uid_start_number: 2000,
  gid_start_number: 4000,
  search_mode: 'direct',
  bind_mode: 'direct',
  mfa_support: false,
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing base_dn', async () => {
  const res = await validate(ctxOf([{ ...good, base_dn: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_BASE_DN'))
})

test('validate rejects an unknown search_mode', async () => {
  const res = await validate(ctxOf([{ ...good, search_mode: 'fuzzy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEARCH_MODE'))
})

test('validate rejects an unknown bind_mode', async () => {
  const res = await validate(ctxOf([{ ...good, bind_mode: 'fuzzy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BIND_MODE'))
})

test('validate accepts a fully populated provider', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('readOptionalInt tolerates numeric strings and blanks', () => {
  assert.equal(readOptionalInt(2000), 2000)
  assert.equal(readOptionalInt('4000'), 4000)
  assert.equal(readOptionalInt(''), null)
})

test('readManagedFields defaults invalid modes to direct', () => {
  const managed = readManagedFields({ ...good, search_mode: 'bogus', bind_mode: '' })
  assert.equal(managed.searchMode, 'direct')
  assert.equal(managed.bindMode, 'direct')
})

test('buildCreateBody includes numeric start numbers when declared', () => {
  const body = buildCreateBody(good) as Record<string, unknown>
  assert.equal(body.uid_start_number, 2000)
  assert.equal(body.gid_start_number, 4000)
  assert.equal(body.base_dn, 'DC=ldap,DC=example,DC=com')
})

test('buildCreateBody omits start numbers when blank', () => {
  const body = buildCreateBody({ ...good, uid_start_number: '', gid_start_number: '' }) as Record<string, unknown>
  assert.equal('uid_start_number' in body, false)
  assert.equal('gid_start_number' in body, false)
})

test('snapshotManagedFields reads a live provider', () => {
  const live: AuthentikLDAPProvider = {
    pk: 9,
    name: 'Corp LDAP',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    base_dn: 'DC=ldap,DC=example,DC=com',
    uid_start_number: 2000,
    gid_start_number: 4000,
    search_mode: 'direct',
    bind_mode: 'direct',
    mfa_support: false,
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.baseDn, 'DC=ldap,DC=example,DC=com')
})

test('sameManagedFields detects a changed base_dn', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ ...good, base_dn: 'DC=changed,DC=com' } as AuthentikLDAPProvider)
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.base_dn, 'DC=ldap,DC=example,DC=com')
})
