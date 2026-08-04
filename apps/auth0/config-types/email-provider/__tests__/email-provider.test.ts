import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEmailProviderBody, EMAIL_PROVIDER_NAMES, snapshotEmailProvider } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'ses',
  enabled: true,
  default_from_address: 'no-reply@acme.com',
  credentials: '{"access_key_id":"AKIA...","secret_access_key":"shh","region":"us-east-1"}',
  settings: '{"message":{"configuration_set_name":"acme"}}',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects an unknown provider name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'carrier-pigeon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER'))
})

test('validate rejects a missing default_from_address', async () => {
  const res = await validate(ctxOf([{ ...good, default_from_address: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FROM_ADDRESS'))
})

test('validate rejects malformed credentials JSON', async () => {
  const res = await validate(ctxOf([{ ...good, credentials: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CREDENTIALS'))
})

test('validate rejects empty credentials', async () => {
  const res = await validate(ctxOf([{ ...good, credentials: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CREDENTIALS'))
})

test('validate rejects malformed settings JSON', async () => {
  const res = await validate(ctxOf([{ ...good, settings: '{oops' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETTINGS'))
})

test('validate rejects more than one declared item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'singleton'))
})

// --- _shared helpers ---------------------------------------------------------

test('EMAIL_PROVIDER_NAMES has exactly the documented 10 providers', () => {
  assert.equal(EMAIL_PROVIDER_NAMES.size, 10)
})

test('buildEmailProviderBody parses credentials and settings, and omits blank settings', () => {
  const body = buildEmailProviderBody(good)
  assert.equal(body.name, 'ses')
  assert.equal(body.enabled, true)
  assert.equal(body.default_from_address, 'no-reply@acme.com')
  assert.deepEqual(body.credentials, { access_key_id: 'AKIA...', secret_access_key: 'shh', region: 'us-east-1' })
  assert.deepEqual(body.settings, { message: { configuration_set_name: 'acme' } })

  const withoutSettings = buildEmailProviderBody({ ...good, settings: '' })
  assert.equal('settings' in withoutSettings, false)
})

test('snapshotEmailProvider strips secret-bearing credential keys', () => {
  const snap = snapshotEmailProvider({
    name: 'ses',
    enabled: true,
    default_from_address: 'no-reply@acme.com',
    settings: { message: { configuration_set_name: 'acme' } },
    credentials: { access_key_id: 'AKIA...', secret_access_key: 'shh', region: 'us-east-1' },
  })
  assert.equal(snap.name, 'ses')
  assert.equal(snap.enabled, true)
  assert.deepEqual(snap.nonSecretCredentials, { access_key_id: 'AKIA...', region: 'us-east-1' })
})
