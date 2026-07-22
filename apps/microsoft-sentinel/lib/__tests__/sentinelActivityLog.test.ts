import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  ACTIVITY_LOG_API_VERSION,
  type ActivityLogRecord,
  type DriftActor,
} from '../sentinelActivityLog'
import type { SentinelClient } from '../sentinel'

// --- Fixtures -----------------------------------------------------------------

const OID_CLAIM = 'http://schemas.microsoft.com/identity/claims/objectidentifier'

/** The Veltrix app registration appId (a GUID) — its own deploys appear under this. */
const VELTRIX_APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** The drifted resource's full ARM id — the correlation key. */
const RID =
  '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.OperationalInsights' +
  '/workspaces/ws/providers/Microsoft.SecurityInsights/alertRules/my-rule'

/** A human admin making a managed change (an alertRules write). */
const humanChange: ActivityLogRecord = {
  caller: 'alice@contoso.com',
  eventTimestamp: '2026-07-20T10:00:00.000Z',
  operationName: { value: 'Microsoft.SecurityInsights/alertRules/write' },
  resourceId: RID,
  claims: { [OID_CLAIM]: 'oid-alice', appid: 'portal-app-id' },
}

/** The Veltrix deploy — an app-only actor (a GUID caller) — never attributable. */
const veltrixDeploy: ActivityLogRecord = {
  caller: VELTRIX_APP_ID,
  eventTimestamp: '2026-07-21T09:00:00.000Z',
  operationName: { value: 'Microsoft.SecurityInsights/alertRules/write' },
  resourceId: RID,
  claims: { appid: VELTRIX_APP_ID },
}

/** A human who acted THROUGH the Veltrix app — excluded via the appid claim. */
const humanViaVeltrix: ActivityLogRecord = {
  caller: 'ops@contoso.com',
  eventTimestamp: '2026-07-21T11:00:00.000Z',
  operationName: { value: 'Microsoft.SecurityInsights/alertRules/write' },
  resourceId: RID,
  claims: { [OID_CLAIM]: 'oid-ops', appid: VELTRIX_APP_ID },
}

/** A more-recent human event that is NOT a change (a read) — should be deprioritised. */
const humanRead: ActivityLogRecord = {
  caller: 'alice@contoso.com',
  eventTimestamp: '2026-07-21T12:00:00.000Z',
  operationName: { value: 'Microsoft.SecurityInsights/alertRules/read' },
  resourceId: RID,
  claims: { [OID_CLAIM]: 'oid-alice' },
}

/** A non-human service principal (bare GUID caller) — never attributable. */
const servicePrincipal: ActivityLogRecord = {
  caller: '11112222-3333-4444-5555-666677778888',
  eventTimestamp: '2026-07-21T13:00:00.000Z',
  operationName: { value: 'Microsoft.SecurityInsights/alertRules/write' },
  resourceId: RID,
}

/** A mock SentinelClient whose `request` returns a canned Activity Log page. */
function mockActivityClient(opts: { status?: number; events?: ActivityLogRecord[]; throwErr?: boolean; body?: string } = {}): {
  client: SentinelClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    subscriptionPath: () => '/subscriptions/sub-1',
    request: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ value: opts.events ?? [] })
      return { status, ok: status >= 200 && status < 300, body }
    },
  } as unknown as SentinelClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'sentinel-audit',
      id: 'oid-alice',
      name: 'alice@contoso.com',
      email: 'alice@contoso.com',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'Microsoft.SecurityInsights/alertRules/write',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('ignores a service-principal (bare GUID caller) actor', () => {
    expect(pickActorFromEvents([servicePrincipal], [])).toBeUndefined()
  })

  it('returns undefined when the only events are Veltrix app-only deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], [VELTRIX_APP_ID])).toBeUndefined()
  })

  it('excludes a human who acted through the Veltrix app (by appid claim) and attributes the real change', () => {
    // humanViaVeltrix is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([humanViaVeltrix, humanChange], [VELTRIX_APP_ID])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@contoso.com')
  })

  it('returns undefined when every human event is excluded', () => {
    expect(pickActorFromEvents([humanViaVeltrix], [VELTRIX_APP_ID])).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    expect(pickActorFromEvents([humanViaVeltrix], [VELTRIX_APP_ID.toUpperCase()])).toBeUndefined()
  })

  it('prefers a change event over a more-recent non-change (read) human event', () => {
    const actor = pickActorFromEvents([humanRead, humanChange], [])
    expect(actor?.eventType).toBe('Microsoft.SecurityInsights/alertRules/write')
    expect(actor?.at).toBe('2026-07-20T10:00:00.000Z')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: ActivityLogRecord = { ...humanRead, eventTimestamp: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanRead], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('Microsoft.SecurityInsights/alertRules/read')
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor via the resourceUri-correlated query', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { resourceId: RID, excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@contoso.com')
    expect(calls[0].path).toBe('/subscriptions/sub-1/providers/Microsoft.Insights/eventtypes/management/values')
    expect(String(calls[0].query.$filter)).toContain(`resourceUri eq '${RID}'`)
    expect(String(calls[0].query.$filter)).toContain('eventTimestamp ge')
  })

  it('returns undefined for a Veltrix (app-only) log', async () => {
    const { client } = mockActivityClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, { resourceId: RID, excludeActorLogins: [VELTRIX_APP_ID] })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockActivityClient({ events: [] })
    expect(await resolveDriftActor(client, { resourceId: RID })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const { client } = mockActivityClient({ status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { resourceId: RID })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockActivityClient({ throwErr: true })
    let result: DriftActor | undefined
    let threw = false
    try {
      result = await resolveDriftActor(client, { resourceId: RID })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockActivityClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { resourceId: RID })).toBeUndefined()
  })

  it('does not attribute an unrelated resource (client-side resourceId correlation)', async () => {
    const otherResource: ActivityLogRecord = { ...humanChange, resourceId: `${RID}-OTHER` }
    const { client } = mockActivityClient({ events: [otherResource] })
    expect(await resolveDriftActor(client, { resourceId: RID })).toBeUndefined()
  })

  it('makes no request and returns undefined when no resourceId is given', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('uses the 2015-04-01 management-events api-version', () => {
    expect(ACTIVITY_LOG_API_VERSION).toBe('2015-04-01')
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', async () => {
    const { client } = mockActivityClient({ events: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'my-rule.enabled' },
      { field: 'my-rule.severity' },
    ]
    await attachDriftActor(client, diffs, { resourceId: RID, excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice@contoso.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockActivityClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'my-rule.severity' }]
    await attachDriftActor(client, diffs, { resourceId: RID })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    await attachDriftActor(client, [], { resourceId: RID })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection Client ID (appId) when present', () => {
    expect(veltrixActorLogins({ username: VELTRIX_APP_ID })).toEqual([VELTRIX_APP_ID])
  })

  it('returns an empty list for a missing or blank Client ID', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
