// =============================================================================
// Keycloak Groups — deploy / rollback / healthCheck / driftDetect / getStatus
// driven end to end against the fake Keycloak.
//
// A group's realm role mappings are NOT part of GroupRepresentation: Keycloak
// ignores `realmRoles` on create/update, so they are reconciled separately
// after the group body is written. That second half is where the privilege
// actually lives, so it is what these tests concentrate on.
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

const PLATFORM_TEAM = {
  name: 'platform-team',
  attributes: { costCentre: 'CC-1042' },
  realmRoles: ['app-admin'],
}

function liveGroup(over: Record<string, unknown> = {}) {
  return {
    id: 'group-uuid',
    name: 'platform-team',
    path: '/platform-team',
    attributes: { costCentre: ['CC-1042'] },
    subGroups: [],
    ...over,
  }
}

const NO_ROLE_MAPPINGS = ok([])
const ADMIN_ROLE = ok({ id: 'role-uuid-admin', name: 'app-admin' })

// --- deploy -------------------------------------------------------------------

test('groups deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('groups deploy creates a group, re-reads its id, then maps the declared realm roles', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([]), // search: absent
    created(),
    ok([liveGroup()]), // re-read to capture the id
    NO_ROLE_MAPPINGS, // current realm role mappings
    ADMIN_ROLE, // resolve the declared role name to a ref
    noContent(), // add the mapping
  ])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /groups?search=platform-team',
        'POST /groups',
        'GET /groups?search=platform-team',
        'GET /groups/group-uuid/role-mappings/realm',
        'GET /roles/app-admin',
        'POST /groups/group-uuid/role-mappings/realm',
      ],
    )
    // Attributes go out in Keycloak's Map<String, List<String>> shape.
    assert.deepEqual((bodyOf(vendor[1]) as Record<string, unknown>).attributes, { costCentre: ['CC-1042'] })
    assert.deepEqual(bodyOf(vendor[5]), [{ id: 'role-uuid-admin', name: 'app-admin' }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('groups deploy reconciles role mappings authoritatively, removing what is no longer declared', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([liveGroup()]),
    noContent(), // group body updated
    ok([{ id: 'role-uuid-old', name: 'legacy-role' }]), // current mappings
    ADMIN_ROLE, // resolve the newly declared role
    noContent(), // add
    noContent(), // remove
  ])
  try {
    await deploy(deployContext([item('team', PLATFORM_TEAM)]))

    const vendor = vendorCalls(calls)
    const removal = vendor.find((c) => c.method === 'DELETE')
    assert.ok(removal, 'a role no longer declared must actually be unmapped')
    assert.equal(adminPath(removal), '/groups/group-uuid/role-mappings/realm')
    assert.deepEqual(bodyOf(removal), [{ id: 'role-uuid-old', name: 'legacy-role' }])
  } finally {
    restore()
  }
})

test('groups deploy fails loudly when a declared realm role does not exist', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveGroup()]), noContent(), NO_ROLE_MAPPINGS, notFound()])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /realm role "app-admin" not found/)
  } finally {
    restore()
  }
})

test('groups deploy records the LIVE prior group and its prior role mappings for rollback', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok([liveGroup({ attributes: { costCentre: ['CC-0001'] } })]),
    noContent(),
    ok([{ id: 'role-uuid-old', name: 'legacy-role' }]),
    ADMIN_ROLE,
    noContent(),
    noContent(),
  ])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)]))

    const previous = (
      result.rollbackData as {
        previous: Array<{ id: string; group: { attributes: Record<string, string[]> }; priorRealmRoles: string[] }>
      }
    ).previous
    assert.equal(previous[0].id, 'group-uuid')
    assert.deepEqual(previous[0].group.attributes, { costCentre: ['CC-0001'] }, 'the prior LIVE body, not the canvas')
    assert.deepEqual(previous[0].priorRealmRoles, ['legacy-role'], 'the prior mappings, not the declared ones')
  } finally {
    restore()
  }
})

test('groups deploy records a null prior body for a group it created', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([]), created(), ok([liveGroup()]), NO_ROLE_MAPPINGS])
  try {
    const result = await deploy(deployContext([item('team', { ...PLATFORM_TEAM, realmRoles: [] })]))

    const previous = (result.rollbackData as { previous: Array<{ group: unknown; priorRealmRoles: string[] }> }).previous
    assert.equal(previous[0].group, null, 'a null prior body is what tells rollback to delete it')
    assert.deepEqual(previous[0].priorRealmRoles, [])
  } finally {
    restore()
  }
})

test('groups deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([]), kcError(409, 'Top level group named platform-team already exists')])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('groups deploy skips an item with a blank name without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...PLATFORM_TEAM, name: '' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('groups deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveGroup()]), noContent(), NO_ROLE_MAPPINGS, ADMIN_ROLE, noContent()])
  try {
    const result = await deploy(deployContext([item('team', PLATFORM_TEAM)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('groups rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('groups rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        { previous: [{ name: 'platform-team', id: 'group-uuid', group: liveGroup(), priorRealmRoles: [] }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('groups rollback restores the prior body AND re-reconciles the prior role mappings', async () => {
  const prior = liveGroup({ attributes: { costCentre: ['CC-0001'] } })
  const { calls, restore } = recordKeycloak([
    TOKEN,
    noContent(), // PUT the prior body
    ok([{ id: 'role-uuid-admin', name: 'app-admin' }]), // mappings as the deploy left them
    ok({ id: 'role-uuid-old', name: 'legacy-role' }), // resolve the prior role
    noContent(), // add it back
    noContent(), // remove the one the deploy added
  ])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [{ name: 'platform-team', id: 'group-uuid', group: prior, priorRealmRoles: ['legacy-role'] }],
      }),
    )

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[0].method} ${adminPath(vendor[0])}`, 'PUT /groups/group-uuid')
    assert.deepEqual(bodyOf(vendor[0]), prior)
    // Restoring the body alone would leave the deploy's privilege grant in place.
    const removal = vendor.find((c) => c.method === 'DELETE')
    assert.ok(removal, 'the role the deploy added must be unmapped again')
    assert.deepEqual(bodyOf(removal), [{ id: 'role-uuid-admin', name: 'app-admin' }])
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('groups rollback deletes a group the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'platform-team', id: 'group-uuid', group: null, priorRealmRoles: [] }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /groups/group-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'platform-team', id: 'group-uuid', group: null, priorRealmRoles: [] }] }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('groups rollback skips an entry whose internal id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'platform-team', id: null, group: null, priorRealmRoles: [] }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('groups rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'platform-team', id: 'group-uuid', group: liveGroup(), priorRealmRoles: [] }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('groups driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('groups driftDetect reports no drift when attributes and role mappings match', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveGroup()]), ok([{ id: 'r', name: 'app-admin' }])])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('groups driftDetect reports a role granted out of band', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok([liveGroup()]),
    ok([
      { id: 'r1', name: 'app-admin' },
      { id: 'r2', name: 'realm-admin' },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['platform-team.realmRoles'],
    )
    assert.deepEqual(result.diffs[0].actual, ['app-admin', 'realm-admin'])
  } finally {
    restore()
  }
})

test('groups driftDetect reports a changed attribute', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok([liveGroup({ attributes: { costCentre: ['CC-9999'] } })]),
    ok([{ id: 'r', name: 'app-admin' }]),
  ])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['platform-team.attributes'],
    )
    assert.deepEqual(result.diffs[0].actual, { costCentre: 'CC-9999' })
  } finally {
    restore()
  }
})

test('groups driftDetect skips a group it cannot match rather than asserting false drift', async () => {
  const unreadable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unreadable.restore()
  }

  // `search=` is a substring match, so a near-name must not be accepted as this group.
  const nearMiss = recordKeycloak([TOKEN, ok([{ id: 'other', name: 'platform-team-archive' }])])
  try {
    const result = await driftDetect(driftContext([item('team', PLATFORM_TEAM)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    nearMiss.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('groups', healthCheck)
describeGetStatusContract('groups', getStatus, 'keycloak-groups')
