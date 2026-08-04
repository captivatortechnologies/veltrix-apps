import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRealmPutBody, projectFromFields, projectFromRealmRep, projectionsEqual } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers (deploy/rollback/drift) apply over the Keycloak Admin
 * REST API, which is impractical to mock here. Tests focus on validate.ts and
 * the pure _shared helpers. Realm Settings is a SINGLETON, so the harness
 * always wraps at most one item (not a list).
 */
function toItem(fields: Record<string, unknown>) {
  return { id: 'i0', name: 'Realm Settings', fields }
}

function ctxOf(fields: Record<string, unknown> | null): PipelineContext {
  const items = fields ? [toItem(fields)] : []
  return { canvas: { items } } as unknown as PipelineContext
}

const good = {
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 1800,
  offlineSessionMaxLifespanEnabled: true,
  offlineSessionMaxLifespan: 5184000,
  registrationAllowed: false,
  loginWithEmailAllowed: true,
  duplicateEmailsAllowed: false,
  passwordPolicy: 'length(8) and upperCase(1) and specialChars(1) and notUsername',
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf(null))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate errors when more than one item is declared', async () => {
  const ctx = { canvas: { items: [toItem(good), toItem(good)] } } as unknown as PipelineContext
  const res = await validate(ctx)
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MULTIPLE_ITEMS'))
})

test('validate accepts a good item', async () => {
  const res = await validate(ctxOf(good))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a blank item (every Tokens/Password field optional)', async () => {
  const res = await validate(ctxOf({}))
  assert.equal(res.valid, true)
})

test('validate rejects a negative Tokens field', async () => {
  const res = await validate(ctxOf({ ...good, accessTokenLifespan: -1 }))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NUMBER_FIELD'))
})

test('validate rejects a non-integer Tokens field', async () => {
  const res = await validate(ctxOf({ ...good, ssoSessionIdleTimeout: 12.5 }))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NUMBER_FIELD'))
})

test('validate errors when loginWithEmailAllowed and duplicateEmailsAllowed are both true', () =>
  validate(ctxOf({ loginWithEmailAllowed: true, duplicateEmailsAllowed: true })).then((res) => {
    assert.equal(res.valid, false)
    assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_EMAILS_WITH_LOGIN_BY_EMAIL'))
  }))

test('validate allows duplicateEmailsAllowed when loginWithEmailAllowed is false', async () => {
  const res = await validate(ctxOf({ loginWithEmailAllowed: false, duplicateEmailsAllowed: true }))
  assert.equal(res.valid, true)
})

// --- _shared helpers ---------------------------------------------------------

test('projectFromFields applies Login defaults when the field is absent', () => {
  const projection = projectFromFields({})
  assert.equal(projection.loginWithEmailAllowed, true)
  assert.equal(projection.duplicateEmailsAllowed, false)
  assert.equal(projection.registrationAllowed, false)
  assert.equal(projection.accessTokenLifespan, undefined)
  assert.equal(projection.passwordPolicy, undefined)
})

test('projectFromFields carries through declared Tokens numbers and the password policy', () => {
  const projection = projectFromFields(good)
  assert.equal(projection.accessTokenLifespan, 300)
  assert.equal(projection.ssoSessionIdleTimeout, 1800)
  assert.equal(projection.offlineSessionMaxLifespanEnabled, true)
  assert.equal(projection.offlineSessionMaxLifespan, 5184000)
  assert.equal(projection.passwordPolicy, good.passwordPolicy)
})

test('projectFromFields drops a blank/invalid Tokens field rather than coercing to 0', () => {
  const projection = projectFromFields({ accessTokenLifespan: '' })
  assert.equal(projection.accessTokenLifespan, undefined)
})

test('projectFromRealmRep and projectFromFields agree for an unchanged realm', () => {
  const live = { ...good }
  assert.deepEqual(projectFromRealmRep(live), projectFromFields(good))
})

test('projectionsEqual is true for identical projections and false on any field difference', () => {
  const a = projectFromFields(good)
  const b = projectFromFields(good)
  assert.equal(projectionsEqual(a, b), true)
  assert.equal(projectionsEqual(a, projectFromFields({ ...good, accessTokenLifespan: 600 })), false)
  assert.equal(projectionsEqual(a, projectFromFields({ ...good, registrationAllowed: true })), false)
  assert.equal(projectionsEqual(a, projectFromFields({ ...good, passwordPolicy: 'length(12)' })), false)
})

test('buildRealmPutBody spreads the live rep and overrides only the declared fields', () => {
  const live = { id: 'realm-1', realm: 'demo', smtpServer: { password: 'super-secret' }, accessTokenLifespan: 60 }
  const desired = projectFromFields({ accessTokenLifespan: 900 })
  const body = buildRealmPutBody(live, desired)
  assert.equal(body.id, 'realm-1')
  assert.deepEqual(body.smtpServer, { password: 'super-secret' })
  assert.equal(body.accessTokenLifespan, 900)
})
