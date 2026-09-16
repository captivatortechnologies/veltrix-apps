// =============================================================================
// Keycloak Client Scopes — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// A scope's realm default/optional assignment is not part of
// ClientScopeRepresentation — it lives behind two separate list endpoints and
// decides what every NEW client in the realm silently gets. That assignment is
// what these tests concentrate on.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  TOKEN,
  adminPath,
  bodyOf,
  created,
  deployContext,
  driftContext,
  item,
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const PROFILE_SCOPE = {
  name: 'org-profile',
  description: 'Organisation profile claims',
  protocol: 'openid-connect',
  displayOnConsentScreen: true,
  includeInTokenScope: true,
  includeInOpenidProviderMetadata: true,
  realmDefault: 'default',
}

function liveScope(over: Record<string, unknown> = {}) {
  return {
    id: 'scope-uuid',
    name: 'org-profile',
    description: 'Organisation profile claims',
    protocol: 'openid-connect',
    attributes: {
      'display.on.consent.screen': 'true',
      'include.in.token.scope': 'true',
      'include.in.openid.provider.metadata': 'true',
    },
    ...over,
  }
}

const NO_DEFAULTS = ok([])
const NO_OPTIONALS = ok([])

// --- deploy -------------------------------------------------------------------

test('client-scopes deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('scope', PROFILE_SCOPE)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-scopes deploy creates a scope, re-reads its id, then assigns it as a realm default', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([]), // list: absent (this endpoint has no server-side name filter)
    created(),
    ok([liveScope()]), // re-read to capture the id
    NO_DEFAULTS,
    NO_OPTIONALS,
    noContent(), // assign as a realm default
  ])
  try {
    const result = await deploy(deployContext([item('scope', PROFILE_SCOPE)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /client-scopes',
        'POST /client-scopes',
        'GET /client-scopes',
        'GET /default-default-client-scopes',
        'GET /default-optional-client-scopes',
        'PUT /default-default-client-scopes/scope-uuid',
      ],
    )
    // The assignment endpoints take no request body.
    assert.equal(vendor[5].body, '')
    assert.equal(vendor[5].contentType, null)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('client-scopes deploy writes the consent/token flags into the attributes Keycloak stores them in', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([]), created(), ok([liveScope()]), NO_DEFAULTS, NO_OPTIONALS, noContent()])
  try {
    await deploy(
      deployContext([
        item('scope', { ...PROFILE_SCOPE, displayOnConsentScreen: false, consentScreenText: 'Share your org profile', guiOrder: 3 }),
      ]),
    )

    const body = bodyOf(vendorCalls(calls)[1]) as { attributes: Record<string, string> }
    assert.equal(body.attributes['display.on.consent.screen'], 'false')
    assert.equal(body.attributes['consent.screen.text'], 'Share your org profile')
    assert.equal(body.attributes['gui.order'], '3')
    assert.equal(body.attributes['include.in.token.scope'], 'true')
  } finally {
    restore()
  }
})

test('client-scopes deploy switching default to optional unassigns before assigning', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([liveScope()]),
    noContent(), // scope body updated
    ok([liveScope()]), // currently a realm DEFAULT
    NO_OPTIONALS,
    noContent(), // unassign from defaults
    noContent(), // assign into optionals
  ])
  try {
    await deploy(deployContext([item('scope', { ...PROFILE_SCOPE, realmDefault: 'optional' })]))

    assert.deepEqual(
      vendorCalls(calls).map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /client-scopes',
        'PUT /client-scopes/scope-uuid',
        'GET /default-default-client-scopes',
        'GET /default-optional-client-scopes',
        // Default and optional are mutually exclusive: leaving it in both lists
        // would be a different realm-wide behaviour than the one declared.
        'DELETE /default-default-client-scopes/scope-uuid',
        'PUT /default-optional-client-scopes/scope-uuid',
      ],
    )
  } finally {
    restore()
  }
})

test('client-scopes deploy leaves the assignment alone when it already matches', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([liveScope()]),
    noContent(),
    ok([liveScope()]), // already a realm default
    NO_OPTIONALS,
  ])
  try {
    await deploy(deployContext([item('scope', PROFILE_SCOPE)]))

    const assignmentWrites = writeCalls(calls).filter((c) => /\/default-(default|optional)-client-scopes\//.test(c.path))
    assert.equal(assignmentWrites.length, 0, 'a no-op reconcile must not churn the realm assignment')
  } finally {
    restore()
  }
})

test('client-scopes deploy records the LIVE prior scope and its prior assignment for rollback', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok([liveScope({ protocol: 'saml' })]),
    noContent(),
    NO_DEFAULTS,
    ok([liveScope()]), // currently OPTIONAL
    noContent(), // unassign optional
    noContent(), // assign default
  ])
  try {
    const result = await deploy(deployContext([item('scope', PROFILE_SCOPE)]))

    const previous = (
      result.rollbackData as { previous: Array<{ id: string; scope: { protocol: string }; priorRealmDefault: string }> }
    ).previous
    assert.equal(previous[0].id, 'scope-uuid')
    assert.equal(previous[0].scope.protocol, 'saml', 'the prior LIVE body, not the canvas')
    assert.equal(previous[0].priorRealmDefault, 'optional', 'the prior assignment, not the declared one')
  } finally {
    restore()
  }
})

test('client-scopes deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([]), kcError(409, 'Client Scope org-profile already exists')])
  try {
    const result = await deploy(deployContext([item('scope', PROFILE_SCOPE)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('client-scopes deploy skips an item with a blank name without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...PROFILE_SCOPE, name: '' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-scopes deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveScope()]), noContent(), ok([liveScope()]), NO_OPTIONALS])
  try {
    const result = await deploy(deployContext([item('scope', PROFILE_SCOPE)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('client-scopes rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-scopes rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        { previous: [{ name: 'org-profile', id: 'scope-uuid', scope: liveScope(), priorRealmDefault: 'none' }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-scopes rollback restores the prior body AND the prior realm assignment', async () => {
  const prior = liveScope({ protocol: 'saml' })
  const { calls, restore } = recordKeycloak([
    TOKEN,
    noContent(), // PUT the prior body
    ok([liveScope()]), // the deploy left it as a realm DEFAULT
    NO_OPTIONALS,
    noContent(), // unassign from defaults, back to "none"
  ])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [{ name: 'org-profile', id: 'scope-uuid', scope: prior, priorRealmDefault: 'none' }],
      }),
    )

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[0].method} ${adminPath(vendor[0])}`, 'PUT /client-scopes/scope-uuid')
    assert.deepEqual(bodyOf(vendor[0]), prior)
    // Restoring the body alone would leave every new client in the realm still
    // receiving this scope.
    assert.equal(`${vendor[3].method} ${adminPath(vendor[3])}`, 'DELETE /default-default-client-scopes/scope-uuid')
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('client-scopes rollback deletes a scope the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'org-profile', id: 'scope-uuid', scope: null, priorRealmDefault: 'none' }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /client-scopes/scope-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'org-profile', id: 'scope-uuid', scope: null, priorRealmDefault: 'none' }] }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('client-scopes rollback skips an entry whose internal id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'org-profile', id: null, scope: null, priorRealmDefault: 'none' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-scopes rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'org-profile', id: 'scope-uuid', scope: liveScope(), priorRealmDefault: 'none' }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('client-scopes driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('scope', PROFILE_SCOPE)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-scopes driftDetect reports no drift when the scope and its assignment match', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveScope()]), ok([liveScope()]), NO_OPTIONALS])
  try {
    const result = await driftDetect(driftContext([item('scope', PROFILE_SCOPE)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('client-scopes driftDetect reports a scope quietly promoted to a realm default', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveScope()]), ok([liveScope()]), NO_OPTIONALS])
  try {
    const result = await driftDetect(driftContext([item('scope', { ...PROFILE_SCOPE, realmDefault: 'none' })]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['org-profile.realmDefault'],
    )
    assert.equal(result.diffs[0].expected, 'none')
    assert.equal(result.diffs[0].actual, 'default')
  } finally {
    restore()
  }
})

test('client-scopes driftDetect reports a consent flag flipped in the console', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok([liveScope({ attributes: { 'display.on.consent.screen': 'false', 'include.in.token.scope': 'true' } })]),
    ok([liveScope()]),
    NO_OPTIONALS,
  ])
  try {
    const result = await driftDetect(driftContext([item('scope', PROFILE_SCOPE)]))

    assert.equal(result.hasDrift, true)
    assert.ok(result.diffs.some((d) => d.field === 'org-profile.displayOnConsentScreen'))
  } finally {
    restore()
  }
})

test('client-scopes driftDetect skips a scope it cannot match rather than asserting false drift', async () => {
  const unreadable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('scope', PROFILE_SCOPE)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unreadable.restore()
  }

  const absent = recordKeycloak([TOKEN, ok([{ id: 'other', name: 'unrelated' }])])
  try {
    const result = await driftDetect(driftContext([item('scope', PROFILE_SCOPE)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    absent.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('client-scopes', healthCheck)
describeGetStatusContract('client-scopes', getStatus, 'keycloak-client-scopes')
