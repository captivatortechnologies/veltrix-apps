import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  buildPatchBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readStringList,
  sameManagedFields,
  sameStringSet,
  snapshotManagedFields,
  UUID_PATTERN,
  type AuthentikOAuth2Provider,
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
  name: 'Grafana OIDC',
  authorization_flow: AUTHZ_FLOW,
  invalidation_flow: INVAL_FLOW,
  client_type: 'confidential',
  client_id: 'grafana',
  signing_key: '',
  redirect_uris: 'https://grafana.example.com/login/generic_oauth',
  property_mappings: [],
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing authorization_flow', async () => {
  const res = await validate(ctxOf([{ ...good, authorization_flow: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_AUTHORIZATION_FLOW'))
})

test('validate rejects a non-UUID authorization_flow', async () => {
  const res = await validate(ctxOf([{ ...good, authorization_flow: 'not-a-uuid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AUTHORIZATION_FLOW'))
})

test('validate rejects a missing invalidation_flow', async () => {
  const res = await validate(ctxOf([{ ...good, invalidation_flow: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INVALIDATION_FLOW'))
})

test('validate rejects an unknown client_type', async () => {
  const res = await validate(ctxOf([{ ...good, client_type: 'anonymous' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_TYPE'))
})

test('validate rejects a non-UUID signing_key', async () => {
  const res = await validate(ctxOf([{ ...good, signing_key: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SIGNING_KEY'))
})

test('validate accepts a blank signing_key', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects zero redirect URIs', async () => {
  const res = await validate(ctxOf([{ ...good, redirect_uris: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REDIRECT_URIS'))
})

test('validate rejects a non-UUID property mapping', async () => {
  const res = await validate(ctxOf([{ ...good, property_mappings: ['not-a-uuid'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROPERTY_MAPPING'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a fully populated provider', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('UUID_PATTERN matches a v4-shaped UUID and rejects garbage', () => {
  assert.equal(UUID_PATTERN.test(AUTHZ_FLOW), true)
  assert.equal(UUID_PATTERN.test('not-a-uuid'), false)
})

test('readStringList trims, de-duplicates and accepts arrays or delimited strings', () => {
  assert.deepEqual(readStringList('a\nb, a'), ['a', 'b'])
  assert.deepEqual(readStringList(['a', ' a ', 'b']), ['a', 'b'])
  assert.deepEqual(readStringList(''), [])
})

test('sameStringSet is order-insensitive', () => {
  assert.equal(sameStringSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameStringSet(['a'], ['a', 'b']), false)
})

test('readManagedFields defaults an invalid/blank client_type to confidential', () => {
  const managed = readManagedFields({ ...good, client_type: '' })
  assert.equal(managed.clientType, 'confidential')
  assert.equal(managed.authorizationFlow, AUTHZ_FLOW)
})

test('buildCreateBody omits client_id/signing_key/property_mappings when blank', () => {
  const body = buildCreateBody({ ...good, client_id: '', signing_key: '', property_mappings: [] }) as Record<string, unknown>
  assert.equal('client_id' in body, false)
  assert.equal('signing_key' in body, false)
  assert.equal('property_mappings' in body, false)
  assert.deepEqual(body.redirect_uris, [{ matching_mode: 'strict', url: 'https://grafana.example.com/login/generic_oauth', redirect_uri_type: 'authorization' }])
})

test('buildPatchBody includes client_id when declared', () => {
  const body = buildPatchBody(good) as Record<string, unknown>
  assert.equal(body.client_id, 'grafana')
  assert.equal(body.name, 'Grafana OIDC')
})

test('snapshotManagedFields reads a live provider, including redirect URL extraction', () => {
  const live: AuthentikOAuth2Provider = {
    pk: 7,
    name: 'Grafana OIDC',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    client_type: 'confidential',
    client_id: 'grafana',
    signing_key: null,
    redirect_uris: [{ matching_mode: 'strict', url: 'https://grafana.example.com/login/generic_oauth', redirect_uri_type: 'authorization' }],
    property_mappings: [],
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.clientId, 'grafana')
  assert.deepEqual(snap.redirectUrls, ['https://grafana.example.com/login/generic_oauth'])
})

test('sameManagedFields ignores clientId/signingKey/propertyMappings drift when not declared', () => {
  const expected = readManagedFields({ ...good, client_id: '', signing_key: '', property_mappings: [] })
  const actual = snapshotManagedFields({
    name: 'Grafana OIDC',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    client_type: 'confidential',
    client_id: 'auto-generated-xyz',
    signing_key: 'c3d4e5f6-a7b8-4901-c234-56789abcdef0',
    redirect_uris: [{ url: 'https://grafana.example.com/login/generic_oauth' }],
    property_mappings: ['d4e5f6a7-b8c9-4012-d345-6789abcdef01'],
  })
  assert.equal(sameManagedFields(expected, actual), true)
})

test('sameManagedFields flags a declared clientId that no longer matches', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({
    name: 'Grafana OIDC',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    client_type: 'confidential',
    client_id: 'changed-elsewhere',
    redirect_uris: [{ url: 'https://grafana.example.com/login/generic_oauth' }],
  })
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.name, 'Grafana OIDC')
  assert.equal(body.client_id, 'grafana')
})
