import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  eventMatchesTarget,
  type AuditLogEvent,
  type DriftActor,
} from '../tenableAudit'
import type { TenableClient } from '../../../lib/tenable'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (a scan update) to the target. */
const humanChange: AuditLogEvent = {
  id: 'e1',
  received: '2026-07-20T10:00:00.000Z',
  action: 'scan.update',
  crud: 'u',
  actor: { id: 'u-alice', name: 'alice@acme.com' },
  target: { id: 'scan-1', name: 'Nightly Scan', type: 'Scan' },
}

/** The Veltrix service/deploy identity — must be excluded from attribution. */
const veltrixDeploy: AuditLogEvent = {
  id: 'e2',
  received: '2026-07-21T09:00:00.000Z',
  action: 'scan.update',
  crud: 'u',
  actor: { id: 'access-key-abc', name: 'veltrix-svc' },
  target: { id: 'scan-1', name: 'Nightly Scan', type: 'Scan' },
}

/** A more-recent human event that is NOT a change (a read) — should be deprioritised. */
const humanRead: AuditLogEvent = {
  id: 'e3',
  received: '2026-07-21T12:00:00.000Z',
  action: 'scan.details',
  crud: 'r',
  actor: { id: 'u-alice', name: 'alice@acme.com' },
  target: { id: 'scan-1', name: 'Nightly Scan', type: 'Scan' },
}

/** An anonymous/system event with no identifiable actor — never attributable. */
const anonymousEvent: AuditLogEvent = {
  id: 'e4',
  received: '2026-07-21T13:00:00.000Z',
  action: 'scan.update',
  crud: 'u',
  is_anonymous: true,
  actor: {},
  target: { id: 'scan-1', name: 'Nightly Scan', type: 'Scan' },
}

/** A change by a non-email actor (a display name) — id kept, no email. */
const humanNamedChange: AuditLogEvent = {
  id: 'e5',
  received: '2026-07-20T08:00:00.000Z',
  action: 'user.edit',
  crud: 'u',
  actor: { id: 'u-bob', name: 'Bob Admin' },
  target: { id: 'user-9', name: 'bob', type: 'User' },
}

/** A mock TenableClient whose `request` returns a canned audit-log page. */
function mockAuditClient(
  opts: { status?: number; events?: AuditLogEvent[]; throwErr?: boolean; body?: string } = {},
): {
  client: TenableClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    request: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ events: opts.events ?? [] })
      return { status, ok: status >= 200 && status < 300, body }
    },
  } as unknown as TenableClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'tenable-audit',
      id: 'u-alice',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'scan.update',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix identity and attributes the human change instead', () => {
    // Veltrix event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixDeploy, humanChange], ['veltrix-svc'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['veltrix-svc'])).toBeUndefined()
  })

  it('excludes Veltrix by actor id too (case-insensitive)', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['ACCESS-KEY-ABC'])).toBeUndefined()
  })

  it('prefers a change event over a more-recent read by a human', () => {
    const actor = pickActorFromEvents([humanRead, humanChange], [])
    expect(actor?.eventType).toBe('scan.update')
    expect(actor?.at).toBe('2026-07-20T10:00:00.000Z')
  })

  it('falls back to the most recent event when none is a change type', () => {
    const olderRead: AuditLogEvent = { ...humanRead, id: 'e3b', received: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([olderRead, humanRead], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('scan.details')
  })

  it('ignores anonymous / unidentifiable actors', () => {
    expect(pickActorFromEvents([anonymousEvent], [])).toBeUndefined()
  })

  it('keeps a non-email actor name as name+id but sets no email', () => {
    const actor = pickActorFromEvents([humanNamedChange], [])
    expect(actor?.name).toBe('Bob Admin')
    expect(actor?.id).toBe('u-bob')
    expect(actor?.email).toBeUndefined()
  })
})

// --- eventMatchesTarget (pure) -----------------------------------------------

describe('eventMatchesTarget', () => {
  it('matches by target id', () => {
    expect(eventMatchesTarget(humanChange, 'scan-1', undefined)).toBeTruthy()
  })

  it('matches by target name (case-insensitive)', () => {
    expect(eventMatchesTarget(humanChange, undefined, 'nightly scan')).toBeTruthy()
  })

  it('does not match a different target', () => {
    expect(eventMatchesTarget(humanChange, 'scan-2', 'Other')).toBeFalsy()
  })

  it('does not match when neither id nor name is given', () => {
    expect(eventMatchesTarget(humanChange, undefined, undefined)).toBeFalsy()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by target id and queries the audit log', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'scan-1', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@acme.com')
    expect(calls[0].path).toBe('/audit-log/v1/events')
    expect(String(calls[0].query.f)).toContain('date.gt:')
    expect(calls[0].query.limit).toBe(50)
  })

  it('resolves a human actor correlated by target name', async () => {
    const { client } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Nightly Scan', excludeActorLogins: [] })
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('ignores events for a different target (no correlation)', async () => {
    const other: AuditLogEvent = { ...humanChange, target: { id: 'scan-99', name: 'Other Scan' } }
    const { client } = mockAuditClient({ events: [other] })
    expect(await resolveDriftActor(client, { targetId: 'scan-1', targetName: 'Nightly Scan' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only correlated log', async () => {
    const { client } = mockAuditClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, {
      targetId: 'scan-1',
      excludeActorLogins: ['veltrix-svc'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockAuditClient({ events: [] })
    expect(await resolveDriftActor(client, { targetId: 'scan-1' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort, e.g. admin-only 403)', async () => {
    const { client } = mockAuditClient({ status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: 'scan-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    expect(await resolveDriftActor(client, { targetId: 'scan-1' })).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockAuditClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: 'scan-1' })).toBeUndefined()
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
      { field: 'Nightly Scan.textTargets' },
      { field: 'Nightly Scan.rrules' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'scan-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice@acme.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Nightly Scan.textTargets' }]
    await attachDriftActor(client, diffs, { targetId: 'scan-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'scan-1' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username when present', () => {
    expect(veltrixActorLogins({ username: 'access-key-abc' })).toEqual(['access-key-abc'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
