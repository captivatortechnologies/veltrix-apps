import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildClientRep,
  findClientByClientId,
  normalizeBool,
  parseRedirectUris,
  projectFromFields,
  projectFromLive,
  redirectUrisEqual,
  type KeycloakClientRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https
 * inside keycloakApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.clientId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  clientId: 'web-app',
  name: 'Web App',
  protocol: 'openid-connect',
  enabled: true,
  publicClient: false,
  standardFlowEnabled: true,
  redirectUris: 'https://app.example.com/*',
}

// --- validate ----------------------------------------------------------------

test('validate rejects a missing clientId', async () => {
  const res = await validate(ctxOf([{ ...good, clientId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CLIENT_ID'))
})

test('validate rejects a clientId with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, clientId: 'web app' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ID'))
})

test('validate rejects an unknown protocol', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'ldap' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate warns when standard flow is on but no redirect URI is set', async () => {
  const res = await validate(ctxOf([{ ...good, redirectUris: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_REDIRECT_URI'))
})

test('validate warns on a duplicate clientId', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_CLIENT_ID'))
})

test('validate accepts a good client for each protocol', async () => {
  for (const protocol of ['openid-connect', 'saml']) {
    const res = await validate(ctxOf([{ ...good, protocol }]))
    assert.equal(res.valid, true, `expected ${protocol} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('normalizeBool coerces strings and falls back', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool('nonsense', false), false)
})

test('parseRedirectUris splits newlines and commas and trims', () => {
  assert.deepEqual(parseRedirectUris('https://a/*\nhttps://b/*'), ['https://a/*', 'https://b/*'])
  assert.deepEqual(parseRedirectUris(' https://a/* , https://b/* '), ['https://a/*', 'https://b/*'])
  assert.deepEqual(parseRedirectUris(''), [])
  assert.deepEqual(parseRedirectUris(['https://a/*', ' ']), ['https://a/*'])
})

test('redirectUrisEqual is order-insensitive', () => {
  assert.equal(redirectUrisEqual(['a', 'b'], ['b', 'a']), true)
  assert.equal(redirectUrisEqual(['a'], ['a', 'b']), false)
})

test('findClientByClientId matches on clientId only', () => {
  const list: KeycloakClientRep[] = [
    { id: 'uuid-1', clientId: 'web-app' },
    { id: 'uuid-2', clientId: 'api' },
  ]
  assert.equal(findClientByClientId(list, 'api')?.id, 'uuid-2')
  assert.equal(findClientByClientId(list, 'missing'), null)
})

test('buildClientRep produces a full representation from fields', () => {
  const rep = buildClientRep(good)
  assert.equal(rep.clientId, 'web-app')
  assert.equal(rep.protocol, 'openid-connect')
  assert.equal(rep.enabled, true)
  assert.equal(rep.publicClient, false)
  assert.equal(rep.standardFlowEnabled, true)
  assert.deepEqual(rep.redirectUris, ['https://app.example.com/*'])
  assert.equal(rep.name, 'Web App')
})

test('buildClientRep preserves unmanaged fields from the existing client on update', () => {
  const existing: KeycloakClientRep = {
    id: 'uuid-1',
    clientId: 'web-app',
    protocolMappers: [{ name: 'audience' }],
    attributes: { 'post.logout.redirect.uris': '+' },
  }
  const rep = buildClientRep({ ...good, enabled: false }, existing)
  assert.equal(rep.id, 'uuid-1')
  assert.equal(rep.enabled, false)
  assert.deepEqual(rep.protocolMappers, [{ name: 'audience' }])
  assert.deepEqual(rep.attributes, { 'post.logout.redirect.uris': '+' })
})

test('projectFromFields and projectFromLive agree for an unchanged client', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakClientRep = {
    id: 'uuid-1',
    clientId: 'web-app',
    name: 'Web App',
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    standardFlowEnabled: true,
    redirectUris: ['https://app.example.com/*'],
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})
