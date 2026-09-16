// =============================================================================
// Shared `healthCheck` contract for every Keycloak configuration type.
//
// All 16 healthCheck handlers reduce to the same signal (lib/health.ts, which
// `clients/healthCheck.ts` additionally inlines verbatim): Keycloak issues an
// admin token AND the managed realm answers GET /admin/realms/{realm}. One
// contract suite, invoked from each config type's own __tests__ folder, asserts
// the whole behaviour — including the two things that matter most here, that a
// missing credential never reaches the network and that the admin bearer token
// never reaches the result.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  ADMIN_BASE,
  ADMIN_TOKEN,
  REALM,
  TOKEN,
  TOKEN_DENIED,
  healthContext,
  isTokenCall,
  kcError,
  leaksToken,
  ok,
  recordKeycloak,
  transportError,
  vendorCalls,
} from './fakeKeycloak'

type HealthCheckHandler = (ctx: HealthCheckContext) => Promise<HealthCheckResult>

/** Register the healthCheck contract suite for one configuration type. */
export function describeHealthCheckContract(label: string, healthCheck: HealthCheckHandler): void {
  test(`${label} healthCheck refuses without a credential instead of probing the realm`, async () => {
    const { calls, restore } = recordKeycloak([])
    try {
      const result = await healthCheck(healthContext({ credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks.length, 1)
      assert.equal(result.checks[0].name, 'credential')
      assert.equal(result.checks[0].passed, false)
      assert.equal(calls.length, 0, 'must not reach Keycloak without a credential')
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck obtains the admin token before the realm probe`, async () => {
    const { calls, restore } = recordKeycloak([TOKEN, ok({ realm: REALM, id: 'realm-uuid' })])
    try {
      const result = await healthCheck(healthContext())

      assert.equal(calls.length, 2)
      assert.ok(isTokenCall(calls[0]), `first call must be the token exchange, got ${calls[0].path}`)
      assert.equal(calls[0].method, 'POST')
      assert.match(calls[0].body, /grant_type=client_credentials/)
      // The token exchange itself must never carry a bearer header.
      assert.equal(calls[0].authorization, null)

      assert.equal(calls[1].path, ADMIN_BASE)
      assert.equal(calls[1].method, 'GET')
      assert.equal(calls[1].authorization, `Bearer ${ADMIN_TOKEN}`)

      assert.equal(result.healthy, true)
      assert.equal(result.score, 100)
      assert.equal(result.checks[0].name, 'keycloak_realm_reachable')
      assert.ok(typeof result.checks[0].latencyMs === 'number')
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck never puts the admin token in its result`, async () => {
    const { restore } = recordKeycloak([TOKEN, ok({ realm: REALM })])
    try {
      const result = await healthCheck(healthContext())

      assert.equal(leaksToken(result), false, 'the admin bearer token escaped into the health result')
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck reports unhealthy when the realm rejects the token`, async () => {
    const { calls, restore } = recordKeycloak([TOKEN, kcError(403, 'Forbidden')])
    try {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.match(String(result.checks[0].message), /403/)
      assert.match(String(result.checks[0].message), new RegExp(REALM))
      assert.equal(vendorCalls(calls).length, 1, 'health is one read-only probe, nothing more')
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck reports unhealthy, not a crash, when the token endpoint denies the credential`, async () => {
    const { calls, restore } = recordKeycloak([TOKEN_DENIED])
    try {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.match(String(result.checks[0].message), /Invalid client credentials/)
      // The realm probe is never attempted once the token exchange failed.
      assert.equal(vendorCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck reports unhealthy, not a crash, when Keycloak is unreachable`, async () => {
    const { restore } = recordKeycloak([TOKEN, transportError('ECONNREFUSED')])
    try {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.match(String(result.checks[0].message), /unreachable|ECONNREFUSED/)
    } finally {
      restore()
    }
  })

  test(`${label} healthCheck tolerates a self-signed certificate unless verify_tls is set`, async () => {
    const lenient = recordKeycloak([TOKEN, ok({ realm: REALM })])
    try {
      await healthCheck(healthContext())
      assert.ok(
        lenient.calls.every((call) => call.rejectUnauthorized === false),
        'self-hosted Keycloak commonly ships a self-signed cert; the default must tolerate it',
      )
    } finally {
      lenient.restore()
    }

    const strict = recordKeycloak([TOKEN, ok({ realm: REALM })])
    try {
      await healthCheck(healthContext({ settings: { verify_tls: true } }))
      assert.ok(
        strict.calls.length > 0 && strict.calls.every((call) => call.rejectUnauthorized === true),
        'verify_tls: true must enforce certificate validation on every call, token exchange included',
      )
    } finally {
      strict.restore()
    }
  })
}
