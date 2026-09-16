// =============================================================================
// Keycloak Identity Providers — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// This is where an external IdP's client secret is written, so the secret rules
// are asserted here explicitly: the declared secret goes out on the create, and
// it comes back in no message, no artifact, no rollbackData and no drift diff.
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
  isTokenCall,
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

/** The secret an operator typed into the canvas. It must never come back out. */
const CLIENT_SECRET = 'idp-client-secret-MUST-NOT-ECHO'

/** What Keycloak returns in place of a stored confidential config value. */
const MASKED = '**********'

const OKTA_IDP = {
  alias: 'okta',
  displayName: 'Okta',
  providerId: 'oidc',
  enabled: true,
  config: {
    clientId: 'veltrix-broker',
    clientSecret: CLIENT_SECRET,
    authorizationUrl: 'https://okta.example.com/oauth2/v1/authorize',
    tokenUrl: 'https://okta.example.com/oauth2/v1/token',
  },
}

function liveIdp(over: Record<string, unknown> = {}) {
  return {
    alias: 'okta',
    displayName: 'Okta',
    providerId: 'oidc',
    enabled: true,
    internalId: 'idp-internal-uuid',
    config: {
      clientId: 'veltrix-broker',
      // Keycloak never hands a stored secret back — only this placeholder.
      clientSecret: MASKED,
      authorizationUrl: 'https://okta.example.com/oauth2/v1/authorize',
      tokenUrl: 'https://okta.example.com/oauth2/v1/token',
    },
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('identity-providers deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('okta', OKTA_IDP)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-providers deploy obtains the admin token before the first realm call', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    await deploy(deployContext([item('okta', OKTA_IDP)]))

    assert.ok(isTokenCall(calls[0]))
    assert.equal(calls.filter(isTokenCall).length, 1)
    assert.ok(vendorCalls(calls).every((c) => c.authorization?.startsWith('Bearer ')))
  } finally {
    restore()
  }
})

test('identity-providers deploy creates a provider that does not exist', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    const result = await deploy(deployContext([item('okta', OKTA_IDP)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /identity-provider/instances/okta', 'POST /identity-provider/instances'],
    )
    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.alias, 'okta')
    assert.equal(body.providerId, 'oidc')
    assert.equal(body.enabled, true)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [{ alias: 'okta', idp: null }])
  } finally {
    restore()
  }
})

test('identity-providers deploy SENDS the declared client secret on the create', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    await deploy(deployContext([item('okta', OKTA_IDP)]))

    const body = bodyOf(vendorCalls(calls)[1]) as { config: Record<string, string> }
    // Write-only means write — the federation would simply not work otherwise.
    assert.equal(body.config.clientSecret, CLIENT_SECRET)
    assert.equal(body.config.clientId, 'veltrix-broker')
  } finally {
    restore()
  }
})

test('identity-providers deploy does NOT echo the client secret back in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    const result = await deploy(deployContext([item('okta', OKTA_IDP)]))

    assert.equal(
      JSON.stringify(result).includes(CLIENT_SECRET),
      false,
      'the IdP client secret escaped into the deploy message, artifacts or rollbackData',
    )
    assert.equal(leaksToken(result), false, 'the admin bearer token escaped into the deploy result')
  } finally {
    restore()
  }
})

test('identity-providers deploy updates an existing provider and merges its config forward', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveIdp()), noContent()])
  try {
    await deploy(
      deployContext([
        item('okta', { ...OKTA_IDP, enabled: false, config: { clientId: 'veltrix-broker-v2' } }),
      ]),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /identity-provider/instances/okta', 'PUT /identity-provider/instances/okta'],
    )
    const body = bodyOf(vendor[1]) as { enabled: boolean; internalId: string; config: Record<string, string> }
    assert.equal(body.enabled, false, 'the declared value must win on update')
    assert.equal(body.internalId, 'idp-internal-uuid', 'Keycloak-managed fields must survive an update')
    assert.equal(body.config.clientId, 'veltrix-broker-v2')
    assert.equal(
      body.config.authorizationUrl,
      'https://okta.example.com/oauth2/v1/authorize',
      'config keys the canvas no longer declares are merged forward, not dropped',
    )
  } finally {
    restore()
  }
})

test('identity-providers deploy records the LIVE prior provider for rollback, never a real secret', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveIdp({ enabled: true })), noContent()])
  try {
    const result = await deploy(deployContext([item('okta', { ...OKTA_IDP, enabled: false })]))

    const previous = (result.rollbackData as { previous: Array<{ idp: { enabled: boolean; config: Record<string, string> } }> })
      .previous
    assert.equal(previous[0].idp.enabled, true, 'rollback restores the prior LIVE state, not the canvas values')
    // Keycloak only ever returns the placeholder, so that is all rollbackData
    // can hold — assert it, so a change that starts capturing real secrets fails.
    assert.equal(previous[0].idp.config.clientSecret, MASKED)
    assert.equal(JSON.stringify(result).includes(CLIENT_SECRET), false)
  } finally {
    restore()
  }
})

test('identity-providers deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound(), kcError(400, 'Invalid provider')])
  try {
    const result = await deploy(deployContext([item('okta', OKTA_IDP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

test('identity-providers deploy skips an item with a blank alias without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...OKTA_IDP, alias: '' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('identity-providers rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-providers rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'okta', idp: liveIdp() }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-providers rollback restores the captured prior provider verbatim', async () => {
  const prior = liveIdp({ enabled: true })
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'okta', idp: prior }] }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /identity-provider/instances/okta'],
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.match(String(result.message), /1 restored, 0 deleted/)
  } finally {
    restore()
  }
})

test('identity-providers rollback deletes a provider the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'okta', idp: null }] }))
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /identity-provider/instances/okta'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'okta', idp: null }] }))
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('identity-providers rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'okta', idp: liveIdp() }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('identity-providers driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-providers driftDetect ignores secret config keys, which Keycloak returns masked', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveIdp())])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)]))

    // The canvas holds the real secret and the live provider holds "**********".
    // Diffing those would report permanent, un-actionable drift on every scan.
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('identity-providers driftDetect never puts a secret in a diff', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok(liveIdp({ config: { clientId: 'changed-in-console', clientSecret: MASKED } })),
  ])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['okta.config'],
    )
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(CLIENT_SECRET), false, 'the declared secret escaped into a drift diff')
    assert.equal(serialized.includes('clientSecret'), false, 'secret-bearing keys must be excluded from both sides')
  } finally {
    restore()
  }
})

test('identity-providers driftDetect reports a disabled provider and a changed provider type', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveIdp({ enabled: false, providerId: 'saml' }))])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['okta.providerId', 'okta.enabled'],
    )
  } finally {
    restore()
  }
})

test('identity-providers driftDetect skips a provider it cannot read rather than asserting false drift', async () => {
  const missing = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    missing.restore()
  }

  const unavailable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('okta', OKTA_IDP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unavailable.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('identity-providers', healthCheck)
describeGetStatusContract('identity-providers', getStatus, 'keycloak-identity-providers')
