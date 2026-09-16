// =============================================================================
// Keycloak Identity Provider Mappers — deploy / rollback / healthCheck /
// driftDetect / getStatus driven end to end against the fake Keycloak.
//
// A mapper attaches to an identity provider this config type does not create,
// so the precondition check comes first: a missing IdP must fail the item
// loudly rather than write a mapper onto nothing.
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

const GROUPS_MAPPER = {
  alias: 'okta',
  name: 'groups-import',
  identityProviderMapper: 'oidc-user-attribute-idp-mapper',
  config: { claim: 'groups', 'user.attribute': 'groups', syncMode: 'FORCE' },
}

const IDP_EXISTS = ok({ alias: 'okta', providerId: 'oidc' })

function liveMapper(over: Record<string, unknown> = {}) {
  return {
    id: 'mapper-uuid',
    name: 'groups-import',
    identityProviderAlias: 'okta',
    identityProviderMapper: 'oidc-user-attribute-idp-mapper',
    config: { claim: 'groups', 'user.attribute': 'groups', syncMode: 'FORCE' },
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('identity-provider-mappers deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('groups', GROUPS_MAPPER)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy checks the identity provider exists before writing', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await deploy(deployContext([item('groups', GROUPS_MAPPER)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /identity provider "okta" not found/)
    assert.equal(writeCalls(calls).length, 0, 'nothing may be written onto a provider that is not there')
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy creates a mapper and re-reads it to capture the id', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    IDP_EXISTS,
    ok([]), // mapper list: no match by name
    created(),
    ok([liveMapper()]), // re-read: Keycloak returns the new id only in `location`
  ])
  try {
    const result = await deploy(deployContext([item('groups', GROUPS_MAPPER)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /identity-provider/instances/okta',
        'GET /identity-provider/instances/okta/mappers',
        'POST /identity-provider/instances/okta/mappers',
        'GET /identity-provider/instances/okta/mappers',
      ],
    )
    assert.deepEqual(bodyOf(vendor[2]), {
      name: 'groups-import',
      identityProviderAlias: 'okta',
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: { claim: 'groups', 'user.attribute': 'groups', syncMode: 'FORCE' },
    })
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { alias: 'okta', name: 'groups-import', id: 'mapper-uuid', mapper: null },
    ])
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy updates the matching mapper by id, not by name', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, IDP_EXISTS, ok([liveMapper()]), noContent()])
  try {
    await deploy(
      deployContext([item('groups', { ...GROUPS_MAPPER, config: { claim: 'roles', syncMode: 'IMPORT' } })]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(
      `${vendor[2].method} ${adminPath(vendor[2])}`,
      'PUT /identity-provider/instances/okta/mappers/mapper-uuid',
    )
    const body = bodyOf(vendor[2]) as { config: Record<string, string> }
    // The mapper's config is authoritative: a key dropped from the canvas is
    // dropped from the mapper, not merged forward.
    assert.deepEqual(body.config, { claim: 'roles', syncMode: 'IMPORT' })
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy records the LIVE prior mapper for rollback, not the desired values', async () => {
  const { restore } = recordKeycloak([TOKEN, IDP_EXISTS, ok([liveMapper()]), noContent()])
  try {
    const result = await deploy(
      deployContext([item('groups', { ...GROUPS_MAPPER, config: { claim: 'roles' } })]),
    )

    const previous = (result.rollbackData as { previous: Array<{ mapper: { config: Record<string, string> } }> }).previous
    assert.equal(previous[0].mapper.config.claim, 'groups')
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, IDP_EXISTS, ok([]), kcError(400, 'Unknown mapper type')])
  try {
    const result = await deploy(deployContext([item('groups', GROUPS_MAPPER)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy skips an item missing either half of its composite identity', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(
      deployContext([item('a', { ...GROUPS_MAPPER, alias: '' }), item('b', { ...GROUPS_MAPPER, name: '' })]),
    )

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('identity-provider-mappers deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, IDP_EXISTS, ok([liveMapper()]), noContent()])
  try {
    const result = await deploy(deployContext([item('groups', GROUPS_MAPPER)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('identity-provider-mappers rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-provider-mappers rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        { previous: [{ alias: 'okta', name: 'groups-import', id: 'mapper-uuid', mapper: liveMapper() }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-provider-mappers rollback restores the captured prior mapper verbatim', async () => {
  const prior = liveMapper()
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'okta', name: 'groups-import', id: 'mapper-uuid', mapper: prior }] }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /identity-provider/instances/okta/mappers/mapper-uuid'],
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('identity-provider-mappers rollback deletes a mapper the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'okta', name: 'groups-import', id: 'mapper-uuid', mapper: null }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /identity-provider/instances/okta/mappers/mapper-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'okta', name: 'groups-import', id: 'mapper-uuid', mapper: null }] }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('identity-provider-mappers rollback skips an entry whose id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'okta', name: 'groups-import', id: null, mapper: null }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('identity-provider-mappers driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('groups', GROUPS_MAPPER)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('identity-provider-mappers driftDetect reports no drift when the live mapper matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, IDP_EXISTS, ok([liveMapper()])])
  try {
    const result = await driftDetect(driftContext([item('groups', GROUPS_MAPPER)]))

    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('identity-provider-mappers driftDetect reports a retyped mapper and a changed config', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    IDP_EXISTS,
    ok([liveMapper({ identityProviderMapper: 'oidc-role-idp-mapper', config: { claim: 'roles' } })]),
  ])
  try {
    const result = await driftDetect(driftContext([item('groups', GROUPS_MAPPER)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['okta/groups-import.identityProviderMapper', 'okta/groups-import.config'],
    )
  } finally {
    restore()
  }
})

test('identity-provider-mappers driftDetect skips a missing provider or mapper rather than asserting false drift', async () => {
  const noIdp = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await driftDetect(driftContext([item('groups', GROUPS_MAPPER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noIdp.restore()
  }

  const noMapper = recordKeycloak([TOKEN, IDP_EXISTS, ok([])])
  try {
    const result = await driftDetect(driftContext([item('groups', GROUPS_MAPPER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noMapper.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('identity-provider-mappers', healthCheck)
describeGetStatusContract('identity-provider-mappers', getStatus, 'keycloak-identity-provider-mappers')
