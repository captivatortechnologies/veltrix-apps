// =============================================================================
// Keycloak Protocol Mappers — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// A protocol mapper decides what ends up inside an issued token, and it can
// hang off EITHER a client or a client scope. Picking the wrong parent writes
// claims into the wrong tokens, so both target branches are driven here.
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
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const CLIENT_MAPPER = {
  targetType: 'client',
  targetRef: 'web-app',
  name: 'department',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: { 'user.attribute': 'department', 'claim.name': 'department', 'access.token.claim': 'true' },
}

const SCOPE_MAPPER = { ...CLIENT_MAPPER, targetType: 'client-scope', targetRef: 'org-profile' }

const CLIENT_LOOKUP = ok([{ id: 'uuid-web-app', clientId: 'web-app' }])
const SCOPE_LOOKUP = ok([{ id: 'uuid-org-profile', name: 'org-profile' }])

function liveMapper(over: Record<string, unknown> = {}) {
  return {
    id: 'mapper-uuid',
    name: 'department',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: { 'user.attribute': 'department', 'claim.name': 'department', 'access.token.claim': 'true' },
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('protocol-mappers deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('dept', CLIENT_MAPPER)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers deploy resolves a client target and creates the mapper under it', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([]), created(), ok([liveMapper()])])
  try {
    const result = await deploy(deployContext([item('dept', CLIENT_MAPPER)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /clients?clientId=web-app',
        'GET /clients/uuid-web-app/protocol-mappers/models',
        'POST /clients/uuid-web-app/protocol-mappers/models',
        'GET /clients/uuid-web-app/protocol-mappers/models',
      ],
    )
    assert.deepEqual(bodyOf(vendor[2]), {
      name: 'department',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-usermodel-attribute-mapper',
      config: { 'user.attribute': 'department', 'claim.name': 'department', 'access.token.claim': 'true' },
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('protocol-mappers deploy resolves a client-scope target to the client-scopes path, not the clients path', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, SCOPE_LOOKUP, ok([]), created(), ok([liveMapper()])])
  try {
    await deploy(deployContext([item('dept', SCOPE_MAPPER)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /client-scopes',
        'GET /client-scopes/uuid-org-profile/protocol-mappers/models',
        'POST /client-scopes/uuid-org-profile/protocol-mappers/models',
        'GET /client-scopes/uuid-org-profile/protocol-mappers/models',
      ],
    )
  } finally {
    restore()
  }
})

test('protocol-mappers deploy fails loudly when the target does not exist', async () => {
  const noClient = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await deploy(deployContext([item('dept', CLIENT_MAPPER)]))
    assert.equal(result.success, false)
    assert.match(String(result.message), /client "web-app" not found/)
    assert.equal(writeCalls(noClient.calls).length, 0)
  } finally {
    noClient.restore()
  }

  const noScope = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await deploy(deployContext([item('dept', SCOPE_MAPPER)]))
    assert.equal(result.success, false)
    assert.match(String(result.message), /"org-profile" \(client-scope\) not found/)
    assert.equal(writeCalls(noScope.calls).length, 0)
  } finally {
    noScope.restore()
  }
})

test('protocol-mappers deploy updates the matching mapper by id and replaces its config wholesale', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([liveMapper()]), noContent()])
  try {
    await deploy(
      deployContext([item('dept', { ...CLIENT_MAPPER, config: { 'claim.name': 'dept', 'id.token.claim': 'true' } })]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(
      `${vendor[2].method} ${adminPath(vendor[2])}`,
      'PUT /clients/uuid-web-app/protocol-mappers/models/mapper-uuid',
    )
    const body = bodyOf(vendor[2]) as { config: Record<string, string> }
    assert.deepEqual(
      body.config,
      { 'claim.name': 'dept', 'id.token.claim': 'true' },
      'the config is authoritative: a key removed from the canvas is removed from the mapper',
    )
  } finally {
    restore()
  }
})

test('protocol-mappers deploy records the resolved parent id and LIVE prior mapper for rollback', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([liveMapper()]), noContent()])
  try {
    const result = await deploy(
      deployContext([item('dept', { ...CLIENT_MAPPER, config: { 'claim.name': 'dept' } })]),
    )

    const previous = (
      result.rollbackData as {
        previous: Array<{ resolvedParentId: string; id: string; mapper: { config: Record<string, string> } }>
      }
    ).previous
    // Re-resolving targetRef at rollback time would follow a rename to the
    // wrong client; the id captured here cannot.
    assert.equal(previous[0].resolvedParentId, 'uuid-web-app')
    assert.equal(previous[0].id, 'mapper-uuid')
    assert.equal(previous[0].mapper.config['claim.name'], 'department', 'the prior LIVE config, not the canvas')
  } finally {
    restore()
  }
})

test('protocol-mappers deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([]), kcError(409, 'Protocol mapper exists with same name')])
  try {
    const result = await deploy(deployContext([item('dept', CLIENT_MAPPER)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('protocol-mappers deploy skips an item missing any part of its composite identity', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(
      deployContext([
        item('a', { ...CLIENT_MAPPER, targetType: '' }),
        item('b', { ...CLIENT_MAPPER, targetRef: '' }),
        item('c', { ...CLIENT_MAPPER, name: '' }),
      ]),
    )

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([liveMapper()]), noContent()])
  try {
    const result = await deploy(deployContext([item('dept', CLIENT_MAPPER)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('protocol-mappers rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        {
          previous: [
            {
              targetType: 'client',
              targetRef: 'web-app',
              resolvedParentId: 'uuid-web-app',
              name: 'department',
              id: 'mapper-uuid',
              mapper: liveMapper(),
            },
          ],
        },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers rollback uses the stored parent id without re-resolving the target', async () => {
  const prior = liveMapper()
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          {
            targetType: 'client',
            targetRef: 'renamed-since',
            resolvedParentId: 'uuid-web-app',
            name: 'department',
            id: 'mapper-uuid',
            mapper: prior,
          },
        ],
      }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /clients/uuid-web-app/protocol-mappers/models/mapper-uuid'],
    )
    assert.equal(vendor.filter((c) => c.path.includes('clientId=')).length, 0)
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('protocol-mappers rollback deletes a mapper the deploy created under the right parent kind', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          {
            targetType: 'client-scope',
            targetRef: 'org-profile',
            resolvedParentId: 'uuid-org-profile',
            name: 'department',
            id: 'mapper-uuid',
            mapper: null,
          },
        ],
      }),
    )

    assert.deepEqual(
      vendorCalls(calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /client-scopes/uuid-org-profile/protocol-mappers/models/mapper-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('protocol-mappers rollback skips an entry whose id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          {
            targetType: 'client',
            targetRef: 'web-app',
            resolvedParentId: 'uuid-web-app',
            name: 'department',
            id: null,
            mapper: null,
          },
        ],
      }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          {
            targetType: 'client',
            targetRef: 'web-app',
            resolvedParentId: 'uuid-web-app',
            name: 'department',
            id: 'mapper-uuid',
            mapper: liveMapper(),
          },
        ],
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('protocol-mappers driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('dept', CLIENT_MAPPER)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('protocol-mappers driftDetect reports no drift when the live mapper matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([liveMapper()])])
  try {
    const result = await driftDetect(driftContext([item('dept', CLIENT_MAPPER)]))

    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('protocol-mappers driftDetect reports a claim rewritten in the console', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    ok([liveMapper({ config: { 'user.attribute': 'department', 'claim.name': 'groups', 'access.token.claim': 'true' } })]),
  ])
  try {
    const result = await driftDetect(driftContext([item('dept', CLIENT_MAPPER)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['client:web-app/department.config'],
    )
  } finally {
    restore()
  }
})

test('protocol-mappers driftDetect skips an unresolvable target rather than asserting false drift', async () => {
  const noTarget = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await driftDetect(driftContext([item('dept', CLIENT_MAPPER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noTarget.restore()
  }

  const noMapper = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok([])])
  try {
    const result = await driftDetect(driftContext([item('dept', CLIENT_MAPPER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noMapper.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('protocol-mappers', healthCheck)
describeGetStatusContract('protocol-mappers', getStatus, 'keycloak-protocol-mappers')
