// healthCheck for cloud-registry-connections.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. This config type
// adds a step the others do not have: because the collection has no name
// filter, an extra `registries_listed` check loads the whole list once between
// reachability and the per-registry presence checks — and it only runs when the
// canvas actually declares a registry, so the contract's "an empty canvas needs
// exactly one probe" still holds. Nothing here may surface a registry secret.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  idsPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'cloud-registry-connections',
  handler: healthCheck,
  probePath: '/container-security/queries/registries/v1',
  scopePattern: /registries scope/,
})

/** See deploy.test.ts — the shared fake models Falcon's secrets, not a registry's. */
const REGISTRY_SECRET = 'registry-password-MUST-NOT-LEAK'

function leaksRegistrySecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(REGISTRY_SECRET)
}

const REGISTRY = item('Production Harbor', {
  name: 'prod-harbor',
  url: 'harbor.acme.internal',
  type: 'harbor',
  username: 'veltrix-scanner',
  credential: REGISTRY_SECRET,
})

const LIVE = {
  id: 'reg-live-1',
  user_defined_alias: 'prod-harbor',
  url: 'harbor.acme.internal',
  type: 'harbor',
}

test('cloud-registry-connections healthCheck: passes when every declared registry is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['reg-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([REGISTRY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    assert.deepEqual(
      result.checks.map((c) => c.name),
      ['falcon_reachable', 'registries_listed', 'registry:prod-harbor'],
      'the listing check sits between reachability and the per-registry checks',
    )
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    assert.equal(leaksRegistrySecret(result), false, 'a health result must not carry a registry secret')
  } finally {
    restore()
  }
})

test('cloud-registry-connections healthCheck: fails when a declared registry has been removed in the tenant', async () => {
  // The listing succeeds and simply does not contain the declared alias — that
  // is a real absence, unlike a listing that could not be read.
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([REGISTRY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 67, 'two of three checks passed')
    const listed = result.checks.find((c) => c.name === 'registries_listed')
    assert.ok(listed)
    assert.equal(listed.passed, true)
    const check = result.checks.find((c) => c.name === 'registry:prod-harbor')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-registry-connections healthCheck: does not report a registry as absent when the listing failed', async () => {
  // The reachability probe succeeds and the listing then 500s. That is "I could
  // not look" — turning it into "the registry is gone" tells an operator their
  // image scanning was disconnected when nothing of the sort happened.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([REGISTRY]))

    assert.equal(result.healthy, false)
    const listed = result.checks.find((c) => c.name === 'registries_listed')
    assert.ok(listed, `expected a registries_listed check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(listed.passed, false)
    assert.match(String(listed.message), /internal server error/)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('registry:')),
      false,
      'no per-registry verdict may follow a listing that could not be read',
    )
    assert.equal(result.score, 50, 'one of two checks passed')
  } finally {
    restore()
  }
})

test('cloud-registry-connections healthCheck: does not list registries when the tenant is unreachable', async () => {
  const { restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([REGISTRY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    assert.deepEqual(
      result.checks.map((c) => c.name),
      ['falcon_reachable'],
      'an unreachable tenant must not be reported as the registry being absent',
    )
  } finally {
    restore()
  }
})

test('cloud-registry-connections healthCheck: matches a declared registry by alias, case-insensitively', async () => {
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['reg-live-1']),
    entityPage([{ ...LIVE, user_defined_alias: 'PROD-HARBOR' }]),
  ])
  try {
    const result = await healthCheck(healthContext([REGISTRY]))

    const check = result.checks.find((c) => c.name === 'registry:prod-harbor')
    assert.ok(check)
    assert.equal(check.passed, true)
  } finally {
    restore()
  }
})

test('cloud-registry-connections healthCheck: ignores a registry declaration missing its URL or type', async () => {
  // Those are the fields deploy filters on, so a half-filled section was never
  // deployed and must not be reported as missing from the tenant.
  const incomplete = item('Half-filled', { name: 'half-filled' })
  const { calls, restore } = recordFetch([TOKEN, EMPTY])
  try {
    const result = await healthCheck(healthContext([incomplete]))

    assert.equal(result.healthy, true)
    assert.deepEqual(result.checks.map((c) => c.name), ['falcon_reachable'])
    assert.equal(
      calls.filter((c) => c.url.includes('registries')).length,
      1,
      'nothing deployable means nothing to list beyond the probe',
    )
  } finally {
    restore()
  }
})
