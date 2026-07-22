import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type IntuneAuditEvent,
  type DriftActor,
} from '../intuneAuditLog'
import type { IntuneClient } from '../intune'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (policy patch). */
const humanChange: IntuneAuditEvent = {
  actor: { userPrincipalName: 'alice@contoso.com', userId: 'u-alice', applicationId: 'intune-portal-app' },
  activityDateTime: '2026-07-20T10:00:00.000Z',
  activityOperationType: 'Patch',
  activityType: 'Update DeviceConfiguration',
  displayName: 'Update DeviceConfiguration',
  resources: [{ resourceId: 'pol-1', displayName: 'Baseline AV' }],
}

/** The Veltrix deploy — an app-only actor (no userPrincipalName) — never attributable. */
const veltrixDeploy: IntuneAuditEvent = {
  actor: { applicationId: 'veltrix-app-id', applicationDisplayName: 'Veltrix Provisioner' },
  activityDateTime: '2026-07-21T09:00:00.000Z',
  activityOperationType: 'Patch',
  activityType: 'Update DeviceConfiguration',
  resources: [{ resourceId: 'pol-1', displayName: 'Baseline AV' }],
}

/** A human who acted THROUGH the Veltrix app — excluded via veltrixActorLogins (appId). */
const humanViaVeltrix: IntuneAuditEvent = {
  actor: { userPrincipalName: 'ops@contoso.com', userId: 'u-ops', applicationId: 'veltrix-app-id' },
  activityDateTime: '2026-07-21T11:00:00.000Z',
  activityOperationType: 'Patch',
  activityType: 'Update DeviceConfiguration',
  resources: [{ resourceId: 'pol-1', displayName: 'Baseline AV' }],
}

/** A more-recent human event that is NOT a change (a read) — should be deprioritised. */
const humanRead: IntuneAuditEvent = {
  actor: { userPrincipalName: 'alice@contoso.com', userId: 'u-alice' },
  activityDateTime: '2026-07-21T12:00:00.000Z',
  activityOperationType: 'Get',
  activityType: 'Get DeviceConfiguration',
  displayName: 'Get DeviceConfiguration',
  resources: [{ resourceId: 'pol-1', displayName: 'Baseline AV' }],
}

/** A non-human (application/service) actor — never attributable. */
const appOnly: IntuneAuditEvent = {
  actor: { applicationId: 'some-app', applicationDisplayName: 'Some Service' },
  activityDateTime: '2026-07-21T13:00:00.000Z',
  activityOperationType: 'Patch',
  resources: [{ resourceId: 'pol-1', displayName: 'Baseline AV' }],
}

/** A mock IntuneClient whose `request` returns a canned auditEvents OData page. */
function mockAuditClient(opts: { status?: number; events?: IntuneAuditEvent[]; throwErr?: boolean; body?: string } = {}): {
  client: IntuneClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    request: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ value: opts.events ?? [] })
      return { status, ok: status >= 200 && status < 300, body }
    },
  } as unknown as IntuneClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'intune-audit',
      id: 'u-alice',
      name: 'alice@contoso.com',
      email: 'alice@contoso.com',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'Update DeviceConfiguration',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('ignores an application-only (non-human) actor', () => {
    expect(pickActorFromEvents([appOnly], [])).toBeUndefined()
  })

  it('returns undefined when the only events are Veltrix app-only deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['veltrix-app-id'])).toBeUndefined()
  })

  it('excludes a human who acted through the Veltrix app (by appId) and attributes the real change', () => {
    // humanViaVeltrix is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([humanViaVeltrix, humanChange], ['veltrix-app-id'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@contoso.com')
  })

  it('returns undefined when every human event is excluded', () => {
    expect(pickActorFromEvents([humanViaVeltrix], ['veltrix-app-id'])).toBeUndefined()
  })

  it('excludes the Veltrix identity by application display name too (case-insensitive)', () => {
    expect(pickActorFromEvents([humanViaVeltrix], ['VELTRIX-APP-ID'])).toBeUndefined()
  })

  it('prefers a change event over a more-recent non-change (read) human event', () => {
    const actor = pickActorFromEvents([humanRead, humanChange], [])
    expect(actor?.eventType).toBe('Update DeviceConfiguration')
    expect(actor?.at).toBe('2026-07-20T10:00:00.000Z')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: IntuneAuditEvent = { ...humanRead, activityDateTime: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanRead], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('Get DeviceConfiguration')
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor via the resourceId-correlated query', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'pol-1', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@contoso.com')
    expect(calls[0].path).toBe('/deviceManagement/auditEvents')
    expect(String(calls[0].query.$filter)).toContain("resourceId eq 'pol-1'")
    expect(calls[0].query.$orderby).toBe('activityDateTime desc')
  })

  it('returns undefined for a Veltrix (app-only) log', async () => {
    const { client } = mockAuditClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, { targetId: 'pol-1', excludeActorLogins: ['veltrix-app-id'] })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockAuditClient({ events: [] })
    expect(await resolveDriftActor(client, { targetId: 'pol-1' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const { client } = mockAuditClient({ status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: 'pol-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    let result: DriftActor | undefined
    let threw = false
    try {
      result = await resolveDriftActor(client, { targetId: 'pol-1' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockAuditClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: 'pol-1' })).toBeUndefined()
  })

  it('correlates by displayName when only a targetName is known (deleted object)', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Baseline AV', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@contoso.com')
    expect(String(calls[0].query.$filter)).toContain("displayName eq 'Baseline AV'")
  })

  it('does not attribute an unrelated object (client-side resource correlation)', async () => {
    // The audit page contains a change, but to a DIFFERENT policy id.
    const otherPolicy: IntuneAuditEvent = { ...humanChange, resources: [{ resourceId: 'pol-OTHER', displayName: 'Other' }] }
    const { client } = mockAuditClient({ events: [otherPolicy] })
    expect(await resolveDriftActor(client, { targetId: 'pol-1' })).toBeUndefined()
  })

  it('makes no request and returns undefined when neither id nor name is given', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', async () => {
    const { client } = mockAuditClient({ events: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'Baseline AV.block_email_executable' },
      { field: 'Baseline AV.settings' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'pol-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice@contoso.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Baseline AV.settings' }]
    await attachDriftActor(client, diffs, { targetId: 'pol-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'pol-1' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection Client ID (appId) when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix-app-id' })).toEqual(['veltrix-app-id'])
  })

  it('returns an empty list for a missing or blank Client ID', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
