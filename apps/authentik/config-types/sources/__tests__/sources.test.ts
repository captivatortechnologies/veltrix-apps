import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  buildPatchBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readSourceType,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikSource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.slug ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const oauthGood = {
  name: 'Corp Google',
  slug: 'corp-google',
  type: 'oauth',
  enabled: true,
  provider_type: 'google',
  consumer_key: 'client-id-123',
  consumer_secret: 'super-secret',
}
const ldapGood = {
  name: 'Corp LDAP Source',
  slug: 'corp-ldap-source',
  type: 'ldap',
  enabled: true,
  server_uri: 'ldaps://ldap.example.com',
  base_dn: 'DC=example,DC=com',
  bind_cn: 'CN=svc,DC=example,DC=com',
  bind_password: 'super-secret',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing slug', async () => {
  const res = await validate(ctxOf([{ ...oauthGood, slug: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SLUG'))
})

test('validate rejects an invalid slug', async () => {
  const res = await validate(ctxOf([{ ...oauthGood, slug: 'not a slug' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SLUG'))
})

test('validate requires consumer_key for Type = OAuth', async () => {
  const res = await validate(ctxOf([{ ...oauthGood, consumer_key: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONSUMER_KEY'))
})

test('validate requires server_uri and base_dn for Type = LDAP', async () => {
  const res = await validate(ctxOf([{ ...ldapGood, server_uri: '', base_dn: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SERVER_URI'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_BASE_DN'))
})

test('validate rejects an unknown provider_type', async () => {
  const res = await validate(ctxOf([{ ...oauthGood, provider_type: 'myspace' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER_TYPE'))
})

test('validate accepts both fully populated source types', async () => {
  const res = await validate(ctxOf([oauthGood, ldapGood]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('readSourceType defaults an invalid/blank type to oauth', () => {
  assert.equal(readSourceType('bogus'), 'oauth')
  assert.equal(readSourceType('ldap'), 'ldap')
})

test('buildCreateBody includes slug and the declared secret', () => {
  const body = buildCreateBody(oauthGood) as Record<string, unknown>
  assert.equal(body.slug, 'corp-google')
  assert.equal(body.consumer_secret, 'super-secret')
})

test('buildPatchBody never includes slug, and omits the secret when blank', () => {
  const body = buildPatchBody({ ...oauthGood, consumer_secret: '' }) as Record<string, unknown>
  assert.equal('slug' in body, false)
  assert.equal('consumer_secret' in body, false)
})

test('snapshotManagedFields never carries a secret', () => {
  const live: AuthentikSource = { pk: 'uuid-1', name: 'Corp Google', slug: 'corp-google', enabled: true, provider_type: 'google', consumer_key: 'client-id-123' }
  const snap = snapshotManagedFields(live, 'oauth')
  assert.equal(snap.consumerSecret, '')
})

test('sameManagedFields ignores secrets and detects a changed provider_type', () => {
  const expected = readManagedFields(oauthGood)
  const actualSame = snapshotManagedFields({ pk: '1', name: 'Corp Google', slug: 'corp-google', enabled: true, provider_type: 'google', consumer_key: 'client-id-123' }, 'oauth')
  assert.equal(sameManagedFields(expected, actualSame), true)
  const actualChanged = snapshotManagedFields({ pk: '1', name: 'Corp Google', slug: 'corp-google', enabled: true, provider_type: 'github', consumer_key: 'client-id-123' }, 'oauth')
  assert.equal(sameManagedFields(expected, actualChanged), false)
})

test('managedFieldsToPatchBody never includes a secret', () => {
  const managed = readManagedFields(ldapGood)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  // bindPassword IS declared non-blank in `good`, so it IS forwarded — but a
  // restored (captured) snapshot never carries one (see the prior test).
  assert.equal(body.bind_password, 'super-secret')
})
