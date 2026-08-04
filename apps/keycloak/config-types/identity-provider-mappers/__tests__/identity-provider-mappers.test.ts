import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildMapperRep,
  findMapperByName,
  isSecretConfigKey,
  nonSecretConfig,
  projectFromFields,
  projectFromLive,
  type KeycloakIdpMapperRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  alias: 'corp-google',
  name: 'email-attribute',
  identityProviderMapper: 'oidc-user-attribute-idp-mapper',
  config: { 'user.attribute': 'email', 'claim': 'email' },
}

// --- validate ----------------------------------------------------------------

test('validate rejects a missing alias', async () => {
  const res = await validate(ctxOf([{ ...good, alias: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ALIAS'))
})

test('validate rejects a missing mapper name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a mapper name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'email attribute' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing identityProviderMapper', async () => {
  const res = await validate(ctxOf([{ ...good, identityProviderMapper: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IDENTITY_PROVIDER_MAPPER'))
})

test('validate warns when config is empty', async () => {
  const res = await validate(ctxOf([{ ...good, config: {} }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_CONFIG'))
})

test('validate warns on a duplicate (alias, name) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, identityProviderMapper: 'hardcoded-attribute-idp-mapper' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_MAPPER'))
})

test('validate allows the same mapper name across two different identity providers', async () => {
  const res = await validate(ctxOf([good, { ...good, alias: 'corp-microsoft' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_MAPPER').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good mapper', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('isSecretConfigKey flags secret-bearing keys', () => {
  assert.equal(isSecretConfigKey('clientSecret'), true)
  assert.equal(isSecretConfigKey('some_secret_value'), true)
  assert.equal(isSecretConfigKey('user.attribute'), false)
})

test('nonSecretConfig drops secret keys', () => {
  assert.deepEqual(nonSecretConfig({ 'user.attribute': 'email', apiSecret: 'shh' }), { 'user.attribute': 'email' })
})

test('findMapperByName matches on name only', () => {
  const list: KeycloakIdpMapperRep[] = [
    { id: 'uuid-1', name: 'email-attribute' },
    { id: 'uuid-2', name: 'group-membership' },
  ]
  assert.equal(findMapperByName(list, 'group-membership')?.id, 'uuid-2')
  assert.equal(findMapperByName(list, 'missing'), null)
})

test('buildMapperRep produces a full representation from fields', () => {
  const rep = buildMapperRep(good, 'corp-google')
  assert.equal(rep.name, 'email-attribute')
  assert.equal(rep.identityProviderAlias, 'corp-google')
  assert.equal(rep.identityProviderMapper, 'oidc-user-attribute-idp-mapper')
  assert.deepEqual(rep.config, { 'user.attribute': 'email', claim: 'email' })
})

test('buildMapperRep preserves unmanaged fields from the existing mapper on update', () => {
  const existing: KeycloakIdpMapperRep = {
    id: 'uuid-1',
    name: 'email-attribute',
    identityProviderAlias: 'corp-google',
    identityProviderMapper: 'oidc-user-attribute-idp-mapper',
    config: { 'user.attribute': 'email' },
  }
  const rep = buildMapperRep({ ...good, config: { 'user.attribute': 'mail' } }, 'corp-google', existing)
  assert.equal(rep.id, 'uuid-1')
  // config is authoritative — the declared map fully replaces the prior one.
  assert.deepEqual(rep.config, { 'user.attribute': 'mail' })
})

test('projectFromFields excludes secrets and projectFromLive agrees when unchanged', () => {
  const withSecret = { ...good, config: { ...good.config, apiSecret: 'shh' } }
  const fromFields = projectFromFields(withSecret)
  assert.equal(fromFields.config.apiSecret, undefined)
  const live: KeycloakIdpMapperRep = {
    name: 'email-attribute',
    identityProviderAlias: 'corp-google',
    identityProviderMapper: 'oidc-user-attribute-idp-mapper',
    config: { 'user.attribute': 'email', claim: 'email', apiSecret: '**********' },
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})
