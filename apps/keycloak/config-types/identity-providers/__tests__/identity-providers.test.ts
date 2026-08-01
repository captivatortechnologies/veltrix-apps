import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildIdpRep,
  isSecretConfigKey,
  nonSecretConfig,
  projectFromFields,
  projectFromLive,
  type KeycloakIdpRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.alias ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  alias: 'corp-google',
  displayName: 'Corporate Google',
  providerId: 'google',
  enabled: true,
  config: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' },
}

// --- validate ----------------------------------------------------------------

test('validate rejects a missing alias', async () => {
  const res = await validate(ctxOf([{ ...good, alias: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ALIAS'))
})

test('validate rejects an alias with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, alias: 'corp google' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ALIAS'))
})

test('validate warns on an unknown providerId', async () => {
  const res = await validate(ctxOf([{ ...good, providerId: 'my-custom-idp' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_PROVIDER_ID'))
})

test('validate warns when config is empty', async () => {
  const res = await validate(ctxOf([{ ...good, config: {} }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_CONFIG'))
})

test('validate warns on a duplicate alias', async () => {
  const res = await validate(ctxOf([good, { ...good, displayName: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ALIAS'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good provider', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('isSecretConfigKey flags secret-bearing keys', () => {
  assert.equal(isSecretConfigKey('clientSecret'), true)
  assert.equal(isSecretConfigKey('client_secret'), true)
  assert.equal(isSecretConfigKey('clientId'), false)
})

test('nonSecretConfig drops secret keys', () => {
  assert.deepEqual(nonSecretConfig({ clientId: 'a', clientSecret: 'b' }), { clientId: 'a' })
})

test('buildIdpRep produces a full representation and merges config', () => {
  const rep = buildIdpRep(good)
  assert.equal(rep.alias, 'corp-google')
  assert.equal(rep.providerId, 'google')
  assert.equal(rep.enabled, true)
  assert.equal(rep.displayName, 'Corporate Google')
  assert.deepEqual(rep.config, { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' })
})

test('buildIdpRep preserves unmanaged fields and prior config on update', () => {
  const existing: KeycloakIdpRep = {
    alias: 'corp-google',
    providerId: 'google',
    internalId: 'uuid-1',
    config: { clientId: 'old', hostedDomain: 'corp.example.com' },
  }
  const rep = buildIdpRep({ ...good, config: { clientId: 'new' } }, existing)
  assert.equal(rep.internalId, 'uuid-1')
  // Authored keys win; unmanaged prior config keys survive.
  assert.equal(rep.config?.clientId, 'new')
  assert.equal(rep.config?.hostedDomain, 'corp.example.com')
})

test('projectFromFields excludes secrets and projectFromLive agrees when unchanged', () => {
  const fromFields = projectFromFields(good)
  assert.equal(fromFields.config.clientSecret, undefined)
  const live: KeycloakIdpRep = {
    alias: 'corp-google',
    displayName: 'Corporate Google',
    providerId: 'google',
    enabled: true,
    config: { clientId: 'abc.apps.googleusercontent.com', clientSecret: '**********' },
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})
