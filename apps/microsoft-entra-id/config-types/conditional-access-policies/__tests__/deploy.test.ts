import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'
import {
  isGuid,
  resolveGroups,
  resolveUsers,
  resolveRoles,
  resolveLocations,
  resolveTermsOfUse,
  resolveAuthenticationStrength,
  buildPolicyBody,
  type ResolvedTargets,
} from '../deploy'
import type { CaPolicySpec } from '../validate'

describe('isGuid', () => {
  it('accepts a standard GUID, case-insensitively', () => {
    expect(isGuid('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true)
    expect(isGuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toBe(true)
  })

  it('rejects a display name or a malformed id', () => {
    expect(isGuid('Engineering')).toBe(false)
    expect(isGuid('3fa85f64-5717-4562-b3fc')).toBe(false)
    expect(isGuid('')).toBe(false)
  })
})

describe('resolveGroups — id-aware, backward compatible with hand-typed names', () => {
  const GROUP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  const nameToId = new Map([
    ['engineering', 'g-1'],
    ['sales', 'g-2'],
  ])

  it('passes a picker-stored GUID through unchanged, without consulting the name map', () => {
    const r = resolveGroups([GROUP_ID], new Map())
    expect(r.ids).toEqual([GROUP_ID])
    expect(r.missing).toEqual([])
  })

  it('still resolves a hand-typed display name via the live map (pre-picker behavior)', () => {
    const r = resolveGroups(['Engineering'], nameToId)
    expect(r.ids).toEqual(['g-1'])
    expect(r.missing).toEqual([])
  })

  it('mixes picker ids and hand-typed names in the same field', () => {
    const r = resolveGroups([GROUP_ID, 'Sales'], nameToId)
    expect(r.ids).toEqual([GROUP_ID, 'g-2'])
    expect(r.missing).toEqual([])
  })

  it('reports an unresolved name as missing, same as before the picker existed', () => {
    const r = resolveGroups(['Ghost Group'], nameToId)
    expect(r.ids).toEqual([])
    expect(r.missing).toEqual(['Ghost Group'])
  })
})

describe('resolveUsers — GUID/sentinel passthrough, else displayName/UPN resolution', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111'
  const nameToId = new Map([
    ['ada lovelace', 'u-1'],
    ['ada@contoso.com', 'u-1'],
  ])

  it('passes a picker-stored GUID through unchanged', () => {
    expect(resolveUsers([USER_ID], new Map())).toEqual({ ids: [USER_ID], missing: [] })
  })

  it('passes the documented sentinels through, normalizing hand-typed casing to the canonical form', () => {
    expect(resolveUsers(['All'], new Map())).toEqual({ ids: ['All'], missing: [] })
    expect(resolveUsers(['none'], new Map())).toEqual({ ids: ['None'], missing: [] })
    expect(resolveUsers(['guestsorexternalusers'], new Map())).toEqual({
      ids: ['GuestsOrExternalUsers'],
      missing: [],
    })
  })

  it('resolves a hand-typed display name or UPN via the live map', () => {
    expect(resolveUsers(['Ada Lovelace'], nameToId)).toEqual({ ids: ['u-1'], missing: [] })
    expect(resolveUsers(['ada@contoso.com'], nameToId)).toEqual({ ids: ['u-1'], missing: [] })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolveUsers(['Ghost User'], nameToId)).toEqual({ ids: [], missing: ['Ghost User'] })
  })
})

describe('resolveRoles — GUID passthrough (no sentinel), else displayName resolution', () => {
  const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
  const nameToId = new Map([['global administrator', ROLE_ID]])

  it('passes a picker-stored GUID through unchanged', () => {
    expect(resolveRoles([ROLE_ID], new Map())).toEqual({ ids: [ROLE_ID], missing: [] })
  })

  it('resolves a hand-typed role display name via the live roleDefinitions map', () => {
    expect(resolveRoles(['Global Administrator'], nameToId)).toEqual({ ids: [ROLE_ID], missing: [] })
  })

  it('does not treat "All" as a role sentinel — Conditional Access documents no sentinel for includeRoles/excludeRoles', () => {
    expect(resolveRoles(['All'], new Map())).toEqual({ ids: [], missing: ['All'] })
  })

  it('reports an unresolved role name as missing', () => {
    expect(resolveRoles(['Ghost Role'], nameToId)).toEqual({ ids: [], missing: ['Ghost Role'] })
  })
})

describe('resolveLocations — GUID/sentinel passthrough, else displayName resolution', () => {
  const LOCATION_ID = '198ad66e-87b3-4157-85a3-8a7b51794ee9'
  const nameToId = new Map([['corp ips', LOCATION_ID]])

  it('passes a picker-stored GUID through unchanged', () => {
    expect(resolveLocations([LOCATION_ID], new Map())).toEqual({ ids: [LOCATION_ID], missing: [] })
  })

  it('passes All/AllTrusted through, normalizing casing', () => {
    expect(resolveLocations(['all'], new Map())).toEqual({ ids: ['All'], missing: [] })
    expect(resolveLocations(['ALLTRUSTED'], new Map())).toEqual({ ids: ['AllTrusted'], missing: [] })
  })

  it('resolves a hand-typed named-location display name via the live map', () => {
    expect(resolveLocations(['Corp IPs'], nameToId)).toEqual({ ids: [LOCATION_ID], missing: [] })
  })

  it('reports an unresolved location name as missing', () => {
    expect(resolveLocations(['Ghost Location'], nameToId)).toEqual({ ids: [], missing: ['Ghost Location'] })
  })
})

describe('resolveTermsOfUse — GUID passthrough (no sentinel), else displayName resolution', () => {
  const TOU_ID = 'ce580154-086a-40fd-91df-8a60abac81a0'
  const nameToId = new Map([['contoso terms of use', TOU_ID]])

  it('passes a picker-stored GUID through unchanged', () => {
    expect(resolveTermsOfUse([TOU_ID], new Map())).toEqual({ ids: [TOU_ID], missing: [] })
  })

  it('resolves a hand-typed agreement display name via the live map', () => {
    expect(resolveTermsOfUse(['Contoso Terms of Use'], nameToId)).toEqual({ ids: [TOU_ID], missing: [] })
  })

  it('reports an unresolved agreement name as missing (e.g. the live list 403s under app-only auth)', () => {
    expect(resolveTermsOfUse(['Ghost Agreement'], new Map())).toEqual({ ids: [], missing: ['Ghost Agreement'] })
  })
})

describe('resolveAuthenticationStrength — single-value id-aware resolve', () => {
  const STRENGTH_ID = '00000000-0000-0000-0000-000000000004'
  const nameToId = new Map([['phishing-resistant mfa', STRENGTH_ID]])

  it('treats an empty value as unset, not missing', () => {
    expect(resolveAuthenticationStrength('', new Map())).toEqual({ id: '', missing: false })
  })

  it('passes a picker-stored GUID through unchanged', () => {
    expect(resolveAuthenticationStrength(STRENGTH_ID, new Map())).toEqual({ id: STRENGTH_ID, missing: false })
  })

  it('resolves a hand-typed display name via the live map', () => {
    expect(resolveAuthenticationStrength('Phishing-resistant MFA', nameToId)).toEqual({
      id: STRENGTH_ID,
      missing: false,
    })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolveAuthenticationStrength('Ghost Strength', nameToId)).toEqual({ id: '', missing: true })
  })
})

describe('buildPolicyBody', () => {
  const base: CaPolicySpec = {
    name: 'P',
    state: 'report-only',
    includeAllUsers: false,
    includeGroups: [],
    excludeGroups: [],
    includeUsers: [],
    excludeUsers: [],
    includeRoles: [],
    excludeRoles: [],
    includeLocations: [],
    excludeLocations: [],
    includeAllApps: false,
    includeApps: [],
    grantOperator: 'OR',
    builtInControls: ['mfa'],
    authenticationStrength: '',
    termsOfUse: [],
  }
  const emptyResolved: ResolvedTargets = {
    includeGroups: [],
    excludeGroups: [],
    includeUsers: [],
    excludeUsers: [],
    includeRoles: [],
    excludeRoles: [],
    includeLocations: [],
    excludeLocations: [],
    authenticationStrengthId: '',
    termsOfUse: [],
  }

  it('forwards a picker-selected appId unchanged', () => {
    const body = buildPolicyBody({ ...base, includeApps: ['00000003-0000-0000-c000-000000000000'] }, emptyResolved)
    expect((body.conditions as { applications: { includeApplications: string[] } }).applications.includeApplications).toEqual([
      '00000003-0000-0000-c000-000000000000',
    ])
  })

  it('forwards a picker-selected sentinel keyword unchanged', () => {
    const body = buildPolicyBody({ ...base, includeApps: ['MicrosoftAdminPortals'] }, emptyResolved)
    expect((body.conditions as { applications: { includeApplications: string[] } }).applications.includeApplications).toEqual([
      'MicrosoftAdminPortals',
    ])
  })

  it('wires resolved users/roles into conditions.users alongside groups', () => {
    const body = buildPolicyBody(base, {
      ...emptyResolved,
      includeGroups: ['g-1'],
      excludeGroups: ['g-2'],
      includeUsers: ['u-1', 'All'],
      excludeUsers: ['GuestsOrExternalUsers'],
      includeRoles: ['r-1'],
      excludeRoles: ['r-2'],
    })
    const users = (body.conditions as { users: Record<string, unknown> }).users
    expect(users.includeUsers).toEqual(['u-1', 'All'])
    expect(users.excludeUsers).toEqual(['GuestsOrExternalUsers'])
    expect(users.includeGroups).toEqual(['g-1'])
    expect(users.excludeGroups).toEqual(['g-2'])
    expect(users.includeRoles).toEqual(['r-1'])
    expect(users.excludeRoles).toEqual(['r-2'])
  })

  it('"All users" suppresses includeGroups/includeUsers/includeRoles but not the exclude side', () => {
    const body = buildPolicyBody(
      { ...base, includeAllUsers: true },
      {
        ...emptyResolved,
        includeGroups: ['g-1'],
        includeUsers: ['u-1'],
        includeRoles: ['r-1'],
        excludeUsers: ['GuestsOrExternalUsers'],
        excludeRoles: ['r-2'],
      }
    )
    const users = (body.conditions as { users: Record<string, unknown> }).users
    expect(users.includeUsers).toEqual(['All'])
    expect(users.includeGroups).toEqual([])
    expect(users.includeRoles).toEqual([])
    expect(users.excludeUsers).toEqual(['GuestsOrExternalUsers'])
    expect(users.excludeRoles).toEqual(['r-2'])
  })

  it('omits conditions.locations entirely when no location is targeted', () => {
    const body = buildPolicyBody(base, emptyResolved)
    expect((body.conditions as Record<string, unknown>).locations).toBeUndefined()
  })

  it('sets conditions.locations when at least one side is populated', () => {
    const body = buildPolicyBody(base, { ...emptyResolved, includeLocations: ['All'], excludeLocations: ['loc-1'] })
    expect((body.conditions as Record<string, unknown>).locations).toEqual({
      includeLocations: ['All'],
      excludeLocations: ['loc-1'],
    })
  })

  it('omits grantControls.authenticationStrength when unset', () => {
    const body = buildPolicyBody(base, emptyResolved)
    expect((body.grantControls as Record<string, unknown>).authenticationStrength).toBeUndefined()
  })

  it('sets grantControls.authenticationStrength as an { id } reference when resolved', () => {
    const body = buildPolicyBody(base, { ...emptyResolved, authenticationStrengthId: 'strength-1' })
    expect((body.grantControls as Record<string, unknown>).authenticationStrength).toEqual({ id: 'strength-1' })
  })

  it('omits grantControls.termsOfUse when empty, sets it as a flat id array otherwise', () => {
    const empty = buildPolicyBody(base, emptyResolved)
    expect((empty.grantControls as Record<string, unknown>).termsOfUse).toBeUndefined()

    const populated = buildPolicyBody(base, { ...emptyResolved, termsOfUse: ['tou-1', 'tou-2'] })
    expect((populated.grantControls as Record<string, unknown>).termsOfUse).toEqual(['tou-1', 'tou-2'])
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported resolvers in isolation. What follows
// drives the DEFAULT export — the handler that actually writes Conditional
// Access policies into a customer's directory. A silent failure here locks an
// organisation out or waves an attacker through, so the assertions are about
// the bytes on the wire: which requests, in which order, carrying what `state`.
// ============================================================================

/**
 * The six display-name -> id listings deploy/driftDetect build once per run, in
 * the order the handler requests them: groups, users, roleDefinitions,
 * namedLocations, authenticationStrengthPolicies, termsOfUse agreements.
 */
function nameMaps(over: Record<number, unknown[]> = {}) {
  return [0, 1, 2, 3, 4, 5].map((i) => collection(over[i] ?? []))
}

const POLICIES = '/identity/conditionalAccess/policies'

/** A live policy matching the "MFA for everyone, report-only" canvas item below. */
const LIVE_MATCHING = {
  id: 'p-1',
  displayName: 'Require MFA',
  state: 'enabledForReportingButNotEnforced',
  conditions: {
    users: {
      includeUsers: ['All'],
      excludeUsers: [],
      includeGroups: [],
      excludeGroups: [],
      includeRoles: [],
      excludeRoles: [],
    },
    applications: { includeApplications: ['All'] },
  },
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
}

function mfaItem(fields: Record<string, unknown> = {}) {
  return item('Require MFA', {
    name: 'Require MFA',
    includeAllUsers: true,
    includeAllApps: true,
    builtInControls: ['mfa'],
    ...fields,
  })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([mfaItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([mfaItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed policy listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list Conditional Access policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see live policies must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy acquires a token first and creates a new policy REPORT-ONLY, never enabled', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), ...nameMaps(), created({ id: 'p-new' })])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the policy')
    assert.ok(write.url.includes(POLICIES))

    const body = bodyOf(write)
    assert.ok(body)
    // The canvas said "report-only" (the default). A policy created `enabled`
    // by accident starts blocking sign-ins the moment it lands.
    assert.equal(body.state, 'enabledForReportingButNotEnforced')
    assert.notEqual(body.state, 'enabled')
    assert.equal(result.success, true)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Require MFA', existed: false, id: 'p-new' }])
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy sends state "enabled" only when the canvas explicitly asks for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), ...nameMaps(), created({ id: 'p-new' })])
  try {
    await deploy(deployContext([mfaItem({ state: 'enabled' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body.state, 'enabled')
  } finally {
    restore()
  }
})

test('an unrecognised canvas state falls back to report-only rather than enforcing', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), ...nameMaps(), created({ id: 'p-new' })])
  try {
    await deploy(deployContext([mfaItem({ state: 'Enforced' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body.state, 'enabledForReportingButNotEnforced')
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior state', async () => {
  const livePrior = {
    ...LIVE_MATCHING,
    state: 'enabled',
    grantControls: { operator: 'AND', builtInControls: ['block'] },
  }
  const { calls, restore } = recordFetch([TOKEN, collection([livePrior]), ...nameMaps(), ok({})])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'an existing policy is updated, not duplicated')
    assert.ok(writes[0].url.includes(`${POLICIES}/p-1`))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    // Rollback has to restore what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Require MFA',
      state: 'enabled',
      conditions: livePrior.conditions,
      grantControls: { operator: 'AND', builtInControls: ['block'] },
    })
    const sent = bodyOf(writes[0])
    assert.ok(sent)
    assert.notEqual(sent.state, (entries[0].prior as { state: string }).state)
  } finally {
    restore()
  }
})

test('an unresolvable target name fails the item without writing a partial policy', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), ...nameMaps()])
  try {
    const result = await deploy(
      deployContext([mfaItem({ includeAllUsers: false, includeGroups: ['Ghost Group'] })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown target\(s\) Ghost Group/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a policy whose audience cannot be resolved must not be written at all',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    ...nameMaps(),
    graphError(400, 'The maximum number of policies has been reached.', 'BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /maximum number of policies/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), ...nameMaps(), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Policy', existed: false, id: 'p-old' },
            { name: 'Pre-existing Policy', existed: true, id: 'p-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the policy this app created may be deleted')
    assert.ok(deletes[0].url.includes(`${POLICIES}/p-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
