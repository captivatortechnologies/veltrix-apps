import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  ATTR_CONSENT_SCREEN_TEXT,
  ATTR_DISPLAY_ON_CONSENT_SCREEN,
  ATTR_GUI_ORDER,
  ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA,
  ATTR_INCLUDE_IN_TOKEN_SCOPE,
  REALM_DEFAULT_STATES,
  buildClientScopeRep,
  findClientScopeByName,
  projectFromFields,
  projectFromLive,
  type KeycloakClientScopeRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers (deploy/rollback/drift) apply over the Keycloak Admin REST
 * API — including realm default/optional-assignment reconciliation — which is
 * impractical to mock here. Tests focus on validate.ts and the pure _shared
 * helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'profile-read',
  description: 'Read access to profile claims',
  protocol: 'openid-connect',
  consentScreenText: 'View your profile',
  displayOnConsentScreen: true,
  includeInTokenScope: true,
  includeInOpenidProviderMetadata: true,
  guiOrder: 10,
  realmDefault: 'none',
}

// --- validate ----------------------------------------------------------------

test('validate rejects a missing scope name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE_NAME'))
})

test('validate rejects a scope name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'profile read' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPE_NAME'))
})

test('validate warns on a duplicate scope name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SCOPE_NAME'))
})

test('validate rejects an unknown protocol', async () => {
  const res = await validate(ctxOf([{ ...good, protocol: 'ldap' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate rejects a non-integer GUI order', async () => {
  const res = await validate(ctxOf([{ ...good, guiOrder: 'first' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GUI_ORDER'))
})

test('validate accepts a blank GUI order', async () => {
  const res = await validate(ctxOf([{ ...good, guiOrder: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown realm assignment', async () => {
  const res = await validate(ctxOf([{ ...good, realmDefault: 'always' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REALM_DEFAULT'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good client scope', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('REALM_DEFAULT_STATES holds the three realm-assignment states', () => {
  assert.equal(REALM_DEFAULT_STATES.has('none'), true)
  assert.equal(REALM_DEFAULT_STATES.has('default'), true)
  assert.equal(REALM_DEFAULT_STATES.has('optional'), true)
  assert.equal(REALM_DEFAULT_STATES.has('always'), false)
})

test('findClientScopeByName matches on exact name', () => {
  const list: KeycloakClientScopeRep[] = [
    { id: 's1', name: 'profile-read' },
    { id: 's2', name: 'email-read' },
  ]
  assert.equal(findClientScopeByName(list, 'email-read')?.id, 's2')
  assert.equal(findClientScopeByName(list, 'missing'), null)
})

test('buildClientScopeRep produces a full representation with attributes from fields', () => {
  const rep = buildClientScopeRep(good)
  assert.equal(rep.name, 'profile-read')
  assert.equal(rep.protocol, 'openid-connect')
  assert.equal(rep.description, 'Read access to profile claims')
  assert.deepEqual(rep.attributes, {
    [ATTR_DISPLAY_ON_CONSENT_SCREEN]: 'true',
    [ATTR_INCLUDE_IN_TOKEN_SCOPE]: 'true',
    [ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA]: 'true',
    [ATTR_CONSENT_SCREEN_TEXT]: 'View your profile',
    [ATTR_GUI_ORDER]: '10',
  })
})

test('buildClientScopeRep preserves unmanaged fields and attribute keys from the existing scope on update', () => {
  const existing: KeycloakClientScopeRep = {
    id: 'uuid-1',
    name: 'profile-read',
    protocolMappers: [{ name: 'full name' }],
    attributes: { 'some.other.key': 'kept', [ATTR_GUI_ORDER]: '99' },
  }
  const rep = buildClientScopeRep({ ...good, guiOrder: undefined, consentScreenText: undefined }, existing)
  assert.equal(rep.id, 'uuid-1')
  assert.deepEqual(rep.protocolMappers, [{ name: 'full name' }])
  assert.equal(rep.attributes?.['some.other.key'], 'kept')
  // guiOrder not declared this time -> the prior attribute value survives.
  assert.equal(rep.attributes?.[ATTR_GUI_ORDER], '99')
})

test('buildClientScopeRep keeps a prior description when none is authored', () => {
  const existing: KeycloakClientScopeRep = { name: 'profile-read', description: 'kept' }
  const rep = buildClientScopeRep({ name: 'profile-read', protocol: 'openid-connect' }, existing)
  assert.equal(rep.description, 'kept')
})

test('projectFromFields and projectFromLive agree for an unchanged scope', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakClientScopeRep = {
    name: 'profile-read',
    protocol: 'openid-connect',
    attributes: {
      [ATTR_DISPLAY_ON_CONSENT_SCREEN]: 'true',
      [ATTR_INCLUDE_IN_TOKEN_SCOPE]: 'true',
      [ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA]: 'true',
      [ATTR_CONSENT_SCREEN_TEXT]: 'View your profile',
      [ATTR_GUI_ORDER]: '10',
    },
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})

test('projectFromFields leaves guiOrder/consentScreenText undefined when not declared', () => {
  const proj = projectFromFields({ name: 'minimal', protocol: 'openid-connect' })
  assert.equal(proj.guiOrder, undefined)
  assert.equal(proj.consentScreenText, undefined)
  assert.equal(proj.displayOnConsentScreen, true)
})
