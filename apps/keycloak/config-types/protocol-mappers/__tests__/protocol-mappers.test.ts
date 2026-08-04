import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildMapperRep,
  findMapperByName,
  mapperBasePath,
  projectFromFields,
  projectFromLive,
  type KeycloakProtocolMapperRep,
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
  targetType: 'client',
  targetRef: 'web-app',
  name: 'email-claim',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: { 'user.attribute': 'email', 'claim.name': 'email', 'jsonType.label': 'String' },
}

// --- validate ----------------------------------------------------------------

test('validate rejects an unknown targetType', async () => {
  const res = await validate(ctxOf([{ ...good, targetType: 'realm' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TARGET_TYPE'))
})

test('validate rejects a missing targetRef', async () => {
  const res = await validate(ctxOf([{ ...good, targetRef: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGET_REF'))
})

test('validate rejects a missing mapper name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a mapper name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'email claim' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown protocol', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'ldap' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate rejects a missing protocolMapper', async () => {
  const res = await validate(ctxOf([{ ...good, protocolMapper: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROTOCOL_MAPPER'))
})

test('validate warns on a duplicate (targetType, targetRef, name) triple', async () => {
  const res = await validate(ctxOf([good, { ...good, protocolMapper: 'oidc-hardcoded-claim-mapper' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_MAPPER'))
})

test('validate allows the same mapper name across two different clients', async () => {
  const res = await validate(ctxOf([good, { ...good, targetRef: 'other-app' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_MAPPER').length, 0)
})

test('validate allows the same mapper name on a client and a client scope', async () => {
  const res = await validate(ctxOf([good, { ...good, targetType: 'client-scope' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_MAPPER').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good mapper for each target type', async () => {
  for (const targetType of ['client', 'client-scope']) {
    const res = await validate(ctxOf([{ ...good, targetType }]))
    assert.equal(res.valid, true, `expected ${targetType} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

// --- _shared helpers ---------------------------------------------------------

test('mapperBasePath builds the client and client-scope sub-resource paths', () => {
  assert.equal(mapperBasePath('client', 'uuid-1'), '/clients/uuid-1/protocol-mappers/models')
  assert.equal(mapperBasePath('client-scope', 'uuid-2'), '/client-scopes/uuid-2/protocol-mappers/models')
})

test('findMapperByName matches on name only', () => {
  const list: KeycloakProtocolMapperRep[] = [
    { id: 'uuid-1', name: 'email-claim' },
    { id: 'uuid-2', name: 'groups' },
  ]
  assert.equal(findMapperByName(list, 'groups')?.id, 'uuid-2')
  assert.equal(findMapperByName(list, 'missing'), null)
})

test('buildMapperRep produces a full representation from fields', () => {
  const rep = buildMapperRep(good)
  assert.equal(rep.name, 'email-claim')
  assert.equal(rep.protocol, 'openid-connect')
  assert.equal(rep.protocolMapper, 'oidc-usermodel-attribute-mapper')
  assert.deepEqual(rep.config, { 'user.attribute': 'email', 'claim.name': 'email', 'jsonType.label': 'String' })
})

test('buildMapperRep preserves unmanaged fields from the existing mapper on update', () => {
  const existing: KeycloakProtocolMapperRep = {
    id: 'uuid-1',
    name: 'email-claim',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: { 'user.attribute': 'email' },
  }
  const rep = buildMapperRep({ ...good, config: { 'user.attribute': 'email', 'id.token.claim': 'true' } }, existing)
  assert.equal(rep.id, 'uuid-1')
  // config is authoritative — the declared map fully replaces the prior one.
  assert.deepEqual(rep.config, { 'user.attribute': 'email', 'id.token.claim': 'true' })
})

test('buildMapperRep config is authoritative: a dropped key is dropped, not merged forward', () => {
  const existing: KeycloakProtocolMapperRep = {
    id: 'uuid-1',
    name: 'email-claim',
    config: { 'user.attribute': 'email', 'jsonType.label': 'String' },
  }
  const rep = buildMapperRep({ ...good, config: { 'user.attribute': 'email' } }, existing)
  assert.deepEqual(rep.config, { 'user.attribute': 'email' })
})

test('projectFromFields and projectFromLive agree for an unchanged mapper', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakProtocolMapperRep = {
    name: 'email-claim',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: { 'user.attribute': 'email', 'claim.name': 'email', 'jsonType.label': 'String' },
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})
