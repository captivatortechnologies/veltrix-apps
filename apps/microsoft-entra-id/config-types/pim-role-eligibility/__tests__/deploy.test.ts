import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  page,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { resolveEligibilitySpec, buildRequestBody } from '../deploy'
import { extractEligibilitySpecs } from '../validate'

const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const PRINCIPAL_ID = '071cc716-8147-4397-a5ba-b2105951cc0b'
const AU_ID = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'

const maps = {
  role: new Map([['global administrator', ROLE_ID]]),
  principal: { user: new Map([['ada lovelace', PRINCIPAL_ID]]), group: new Map(), servicePrincipal: new Map() },
  scope: { administrativeUnit: new Map([['west region', AU_ID]]), application: new Map() },
}

function spec(fields: Record<string, unknown>) {
  return extractEligibilitySpecs({ items: [{ fields }] } as never)[0]
}

describe('resolveEligibilitySpec — id-aware, backward compatible with hand-typed names', () => {
  it('passes picker-stored GUIDs/scope through unchanged, without consulting any map', () => {
    const { resolved, missing } = resolveEligibilitySpec(
      spec({ principalId: PRINCIPAL_ID, roleDefinitionId: ROLE_ID, directoryScopeId: '/', justification: 'x' }),
      maps
    )
    expect(resolved.principalId).toBe(PRINCIPAL_ID)
    expect(resolved.roleDefinitionId).toBe(ROLE_ID)
    expect(resolved.directoryScopeId).toBe('/')
    expect(missing).toEqual([])
  })

  it('resolves hand-typed principal/role/scope display names via the live maps', () => {
    const { resolved, missing } = resolveEligibilitySpec(
      spec({ principalId: 'Ada Lovelace', roleDefinitionId: 'Global Administrator', directoryScopeId: 'West Region', justification: 'x' }),
      maps
    )
    expect(resolved.principalId).toBe(PRINCIPAL_ID)
    expect(resolved.roleDefinitionId).toBe(ROLE_ID)
    expect(resolved.directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
    expect(missing).toEqual([])
  })

  it('leaves non-reference fields (justification, ticketing, expiration) untouched', () => {
    const { resolved } = resolveEligibilitySpec(
      spec({
        principalId: PRINCIPAL_ID,
        roleDefinitionId: ROLE_ID,
        justification: 'privileged access',
        ticketNumber: 'CHG123',
        expirationType: 'afterDuration',
        duration: 'P30D',
      }),
      maps
    )
    expect(resolved.justification).toBe('privileged access')
    expect(resolved.ticketNumber).toBe('CHG123')
    expect(resolved.expirationType).toBe('afterDuration')
    expect(resolved.duration).toBe('P30D')
  })

  it('collects every unresolvable reference as missing', () => {
    const { missing } = resolveEligibilitySpec(
      spec({ principalId: 'Ghost User', roleDefinitionId: 'Ghost Role', directoryScopeId: 'Ghost Scope', justification: 'x' }),
      maps
    )
    expect(missing).toEqual(['Ghost Role', 'Ghost User', 'Ghost Scope'])
  })
})

describe('buildRequestBody uses the resolved tuple', () => {
  it('builds an adminAssign body carrying the resolved ids/scope', () => {
    const body = buildRequestBody(
      'adminAssign',
      { principalId: PRINCIPAL_ID, roleDefinitionId: ROLE_ID, directoryScopeId: `/administrativeUnits/${AU_ID}`, justification: 'x', ticketNumber: '', ticketSystem: '' },
      { type: 'noExpiration' }
    )
    expect(body.principalId).toBe(PRINCIPAL_ID)
    expect(body.roleDefinitionId).toBe(ROLE_ID)
    expect(body.directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported resolvers in isolation. What follows
// drives the DEFAULT export — the handler that actually grants PIM role
// eligibility in a customer's directory. PIM has no PUT: every change is a
// unifiedRoleEligibilityScheduleRequest, so the only thing that tells a grant
// from a revocation from a re-scoping is the `action` and the `scheduleInfo`
// on the wire. A mis-sent `adminAssign` is a standing privilege nobody
// approved; a mis-sent expiration turns a 30-day eligibility permanent.
//
// These use `routeFetch` rather than a response queue: deploy builds the role,
// principal and directory-scope name maps with `Promise.all`, and a queue
// would encode an ordering those parallel listings do not guarantee.
// ============================================================================

/** GET /roleManagement/directory/roleEligibilitySchedules?$select=... — the applied state. */
const SCHEDULES = /\/roleEligibilitySchedules\?/
/** POST /roleManagement/directory/roleEligibilityScheduleRequests — every change. */
const REQUESTS = /\/roleEligibilityScheduleRequests$/

const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'
const ADA = '071cc716-8147-4397-a5ba-b2105951cc0b'
const BOB = 'b0b0b0b0-1111-2222-3333-444444444444'

/** A live, applied eligibility for Ada as Global Administrator, tenant-wide. */
function liveSchedule(over: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    status: 'Provisioned',
    scheduleInfo: { expiration: { type: 'noExpiration' } },
    ...over,
  }
}

function eligibilityItem(fields: Record<string, unknown> = {}) {
  return item('Global admin for Ada', {
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    expirationType: 'noExpiration',
    justification: 'Break-glass access',
    ...fields,
  })
}

/** The rollback entry shape a previous deployment records. */
function priorEntry(over: Record<string, unknown> = {}) {
  return {
    name: `${GLOBAL_ADMIN} → ${ADA} @ /`,
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    action: 'adminAssign',
    existed: false,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([eligibilityItem()], { credential: null }))

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
    const result = await deploy(deployContext([eligibilityItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed schedule listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: SCHEDULES, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list role eligibility schedules/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the applied eligibilities would re-request every one of them',
    )
  } finally {
    restore()
  }
})

test('a TRUNCATED schedule listing fails safe rather than re-requesting a privileged grant', async () => {
  const { calls, restore } = routeFetch([
    {
      url: SCHEDULES,
      // A nextLink that matches this same route, so the fake keeps paging until
      // getAll's page budget runs out and reports truncated:true.
      respond: page([], 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleEligibilitySchedules?$skiptoken=next'),
    },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /truncated/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'an eligibility that merely sat on an unread page must not be re-granted as if it were missing',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and requests an adminAssign for an eligibility that is absent', async () => {
  const { calls, restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Provisioned' }) },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the applied schedules are read before anything is requested')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.ok(writes[0].url.endsWith('/roleManagement/directory/roleEligibilityScheduleRequests'))
    assert.deepEqual(bodyOf(writes[0]), {
      action: 'adminAssign',
      principalId: ADA,
      roleDefinitionId: GLOBAL_ADMIN,
      directoryScopeId: '/',
      justification: 'Break-glass access',
      scheduleInfo: { expiration: { type: 'noExpiration' } },
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].action, 'adminAssign')
    assert.equal(entries[0].existed, false, 'provenance — this app granted it, so rollback may revoke it')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a time-bound eligibility is requested with its duration, never as permanent', async () => {
  const { calls, restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Provisioned' }) },
  ])
  try {
    await deploy(deployContext([eligibilityItem({ expirationType: 'afterDuration', duration: 'P30D' })]))

    // Falling back to noExpiration here would silently turn a 30-day grant into
    // standing privilege.
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.scheduleInfo, {
      expiration: { type: 'afterDuration', duration: 'P30D' },
    })
  } finally {
    restore()
  }
})

test('ticketing details travel with the request when the canvas supplies them', async () => {
  const { calls, restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Provisioned' }) },
  ])
  try {
    await deploy(deployContext([eligibilityItem({ ticketNumber: 'CHG-1042', ticketSystem: 'ServiceNow' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.ticketInfo, {
      ticketNumber: 'CHG-1042',
      ticketSystem: 'ServiceNow',
    })
  } finally {
    restore()
  }
})

test('an eligibility already applied with the declared window issues NO request at all', async () => {
  const { calls, restore } = routeFetch([{ url: SCHEDULES, respond: collection([liveSchedule()]) }])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(writeCalls(calls).length, 0, 'a no-op deploy must not churn PIM with a redundant request')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // The entry is still recorded so provenance survives to the next reconcile,
    // but `carried` tells rollback there is nothing here to reverse.
    assert.equal(entries[0].carried, true)
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
    assert.match(String(result.message), /Applied 0 eligibility request\(s\)/)
  } finally {
    restore()
  }
})

test('provenance is sticky — an eligibility this app created stays app-owned across deploys', async () => {
  const { restore } = routeFetch([{ url: SCHEDULES, respond: collection([liveSchedule()]) }])
  try {
    const result = await deploy(
      deployContext([eligibilityItem()], { priorRollbackData: { entries: [priorEntry({ existed: false })] } }),
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(
      entries[0].existed,
      false,
      'losing this would leave an app-created grant permanently un-revokable by a later reconcile',
    )
  } finally {
    restore()
  }
})

test('a changed eligibility window is an adminUpdate that records the LIVE prior expiration', async () => {
  const { calls, restore } = routeFetch([
    {
      url: SCHEDULES,
      respond: collection([liveSchedule({ scheduleInfo: { expiration: { type: 'afterDuration', duration: 'P365D' } } })]),
    },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Provisioned' }) },
  ])
  try {
    const result = await deploy(
      deployContext([eligibilityItem({ expirationType: 'afterDuration', duration: 'P30D' })]),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(bodyOf(writes[0])?.action, 'adminUpdate', 'an applied eligibility is updated, not re-granted')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].action, 'adminUpdate')
    // Rollback has to restore the window the TENANT had, not the one the canvas
    // asked for.
    assert.deepEqual(entries[0].priorExpiration, { type: 'afterDuration', duration: 'P365D' })
    assert.notDeepEqual(
      entries[0].priorExpiration,
      (bodyOf(writes[0])?.scheduleInfo as { expiration: unknown }).expiration,
    )
  } finally {
    restore()
  }
})

test('an unresolvable principal fails the item without requesting anything', async () => {
  const { calls, restore } = routeFetch([{ url: SCHEDULES, respond: collection([]) }])
  try {
    const result = await deploy(deployContext([eligibilityItem({ principalId: 'Ghost User' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown target\(s\) Ghost User/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a grant whose subject cannot be resolved must not be requested against a guessed principal',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected request rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    {
      url: REQUESTS,
      method: 'POST',
      respond: graphError(400, 'The Role assignment already exists.', 'RoleAssignmentExists'),
    },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some eligibility requests failed/)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a request PIM accepted but then DENIED is a failure, and records no rollback entry', async () => {
  const { restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Denied' }) },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /request denied/)
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    // Recording an entry here would have rollback revoke an eligibility that
    // was never granted.
    assert.deepEqual(entries, [])
  } finally {
    restore()
  }
})

test('a request awaiting approval succeeds, but says so', async () => {
  const { restore } = routeFetch([
    { url: SCHEDULES, respond: collection([]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'PendingApproval' }) },
  ])
  try {
    const result = await deploy(deployContext([eligibilityItem()]))

    assert.equal(result.success, true)
    assert.match(String(result.message), /awaiting approval\/provisioning/)
    assert.match(String(result.message), /PendingApproval/)
  } finally {
    restore()
  }
})

test('deploy revokes an eligibility it granted earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: SCHEDULES, respond: collection([liveSchedule(), liveSchedule({ id: 'res-2', principalId: BOB })]) },
    { url: REQUESTS, method: 'POST', respond: created({ id: 'req-1', status: 'Provisioned' }) },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            priorEntry({ existed: false }),
            priorEntry({
              name: `${GLOBAL_ADMIN} → ${BOB} @ /`,
              principalId: BOB,
              existed: true,
            }),
          ],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'only the grant this app made may be revoked')
    assert.deepEqual(bodyOf(writes[0]), {
      action: 'adminRemove',
      principalId: ADA,
      roleDefinitionId: GLOBAL_ADMIN,
      directoryScopeId: '/',
      justification: 'Removed by Veltrix config as code',
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an app-created eligibility that is already gone is not revoked again', async () => {
  const { calls, restore } = routeFetch([{ url: SCHEDULES, respond: collection([]) }])
  try {
    const result = await deploy(
      deployContext([], { priorRollbackData: { entries: [priorEntry({ existed: false })] } }),
    )

    assert.equal(writeCalls(calls).length, 0, 'revoking what is no longer applied is a pointless privileged write')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
