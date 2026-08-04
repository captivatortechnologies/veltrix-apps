import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildTenantSettingsBody, parseFlags, TENANT_FLAG_KEYS } from '../_shared'
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
  friendly_name: 'Acme Corp',
  support_email: 'support@acme.com',
  enabled_locales: ['en', 'es'],
  allowed_logout_urls: 'https://acme.com/logout',
  session_lifetime: 168,
  idle_session_lifetime: 72,
  flags: { enable_sso: 'true', enable_apis_section: 'false' },
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a fully blank item', async () => {
  const res = await validate(ctxOf([{}]))
  assert.equal(res.valid, true)
})

test('validate accepts a well-formed item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects an unknown flag key', async () => {
  const res = await validate(ctxOf([{ ...good, flags: { not_a_real_flag: 'true' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_FLAG'))
})

test('validate rejects a non-boolean-string flag value', async () => {
  const res = await validate(ctxOf([{ ...good, flags: { enable_sso: 'yes' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FLAG_VALUE'))
})

test('validate rejects a zero session_lifetime', async () => {
  const res = await validate(ctxOf([{ ...good, session_lifetime: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SESSION_LIFETIME'))
})

test('validate rejects a negative idle_session_lifetime', async () => {
  const res = await validate(ctxOf([{ ...good, idle_session_lifetime: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IDLE_SESSION_LIFETIME'))
})

test('validate rejects more than one declared item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'singleton'))
})

// --- _shared helpers ---------------------------------------------------------

test('TENANT_FLAG_KEYS has exactly the documented 24 flags', () => {
  assert.equal(TENANT_FLAG_KEYS.size, 24)
})

test('parseFlags keeps only literal "true"/"false" values', () => {
  assert.deepEqual(parseFlags({ enable_sso: 'true', enable_apis_section: 'false', bogus: 'maybe' }), {
    enable_sso: true,
    enable_apis_section: false,
  })
})

test('buildTenantSettingsBody always includes scalar/array fields even when blank', () => {
  const body = buildTenantSettingsBody({})
  assert.equal(body.friendly_name, '')
  assert.deepEqual(body.enabled_locales, [])
  assert.deepEqual(body.allowed_logout_urls, [])
  assert.equal('session_lifetime' in body, false)
  assert.equal('idle_session_lifetime' in body, false)
  assert.equal('flags' in body, false)
})

test('buildTenantSettingsBody includes session lifetimes only when positive', () => {
  assert.equal('session_lifetime' in buildTenantSettingsBody({ session_lifetime: 0 }), false)
  assert.equal(buildTenantSettingsBody({ session_lifetime: 168 }).session_lifetime, 168)
})

test('buildTenantSettingsBody includes flags only with the declared keys', () => {
  const body = buildTenantSettingsBody({ flags: { enable_sso: 'true' } })
  assert.deepEqual(body.flags, { enable_sso: true })
})
