import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type CloudflareAuditEvent,
  type DriftActor,
} from '../cloudflareAudit'
import type { CloudflareClient } from '../../../lib/cloudflare'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (dns_record update) to obj-1. */
const humanChange: CloudflareAuditEvent = {
  actor: { id: 'user-1', email: 'alice@acme.com', type: 'user' },
  when: '2026-07-20T10:00:00Z',
  action: { type: 'update' },
  resource: { id: 'obj-1', type: 'dns_record' },
}

/** The Veltrix API-token/service identity — must be excluded from attribution. */
const veltrixChange: CloudflareAuditEvent = {
  actor: { id: 'user-veltrix', email: 'veltrix-svc@acme.com', type: 'user' },
  when: '2026-07-21T09:00:00Z',
  action: { type: 'update' },
  resource: { id: 'obj-1', type: 'dns_record' },
}

/** A more-recent human event that is NOT a change (a login) — deprioritised. */
const humanNonChange: CloudflareAuditEvent = {
  actor: { id: 'user-1', email: 'alice@acme.com', type: 'user' },
  when: '2026-07-21T12:00:00Z',
  action: { type: 'login' },
  resource: { id: 'obj-1', type: 'dns_record' },
}

/** A non-human (system/token) actor with no email — never attributable. */
const systemEvent: CloudflareAuditEvent = {
  actor: { id: 'tok-1', type: 'api_token' },
  when: '2026-07-21T13:00:00Z',
  action: { type: 'update' },
  resource: { id: 'obj-1', type: 'dns_record' },
}

/** A human change to a DIFFERENT object — must not be correlated to obj-1. */
const otherObjectChange: CloudflareAuditEvent = {
  actor: { id: 'user-2', email: 'mallory@acme.com', type: 'user' },
  when: '2026-07-22T08:00:00Z',
  action: { type: 'update' },
  resource: { id: 'obj-2', type: 'dns_record' },
}

/** A mock CloudflareClient whose `account` returns a canned audit-log page. */
function mockAuditClient(
  opts: { ok?: boolean; status?: number; events?: CloudflareAuditEvent[]; throwErr?: boolean; body?: string } = {},
): {
  client: CloudflareClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const ok = opts.ok ?? true
  const status = opts.status ?? (ok ? 200 : 403)
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    account: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ success: true, result: opts.events ?? [] })
      return { status, ok, body }
    },
  } as unknown as CloudflareClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'cloudflare-audit',
      id: 'user-1',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00Z',
      eventType: 'update',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login (by email) and attributes the human change instead', () => {
    // Veltrix event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['veltrix-svc@acme.com'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('excludes the Veltrix login by actor id too', () => {
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['user-veltrix'])
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixChange], ['veltrix-svc@acme.com'])).toBeUndefined()
  })

  it('excludes Veltrix case-insensitively', () => {
    expect(pickActorFromEvents([veltrixChange], ['VELTRIX-SVC@ACME.COM'])).toBeUndefined()
  })

  it('prefers a change-type event over a more-recent non-change human event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('update')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: CloudflareAuditEvent = { ...humanNonChange, when: '2026-07-19T00:00:00Z' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00Z')
    expect(actor?.eventType).toBe('login')
  })

  it('ignores non-human actors (no "user" type / no email)', () => {
    expect(pickActorFromEvents([systemEvent], [])).toBeUndefined()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by resource.id (targetId)', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'obj-1', excludeActorLogins: [] })
    expect(actor?.email).toBe('alice@acme.com')
    expect(calls[0].path).toBe('/audit_logs')
    expect(calls[0].query.direction).toBe('desc')
    expect(calls[0].query.per_page).toBe(50)
  })

  it('correlates by targetName when the resource.id equals the name (settings)', async () => {
    const settingEvent: CloudflareAuditEvent = {
      actor: { id: 'user-1', email: 'alice@acme.com', type: 'user' },
      when: '2026-07-20T10:00:00Z',
      action: { type: 'update' },
      resource: { id: 'ssl', type: 'settings' },
    }
    const { client } = mockAuditClient({ events: [settingEvent] })
    const actor = await resolveDriftActor(client, { targetName: 'ssl' })
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('does NOT correlate an unrelated object change to the target', async () => {
    const { client } = mockAuditClient({ events: [otherObjectChange] })
    expect(await resolveDriftActor(client, { targetId: 'obj-1' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only correlated log', async () => {
    const { client } = mockAuditClient({ events: [veltrixChange] })
    const actor = await resolveDriftActor(client, {
      targetId: 'obj-1',
      excludeActorLogins: ['veltrix-svc@acme.com'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockAuditClient({ events: [] })
    expect(await resolveDriftActor(client, { targetId: 'obj-1' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (e.g. token lacks audit scope)', async () => {
    const { client } = mockAuditClient({ ok: false, status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: 'obj-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    let result: DriftActor | undefined = { source: 'sentinel' }
    try {
      result = await resolveDriftActor(client, { targetId: 'obj-1' })
    } catch {
      result = { source: 'threw' }
    }
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockAuditClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: 'obj-1' })).toBeUndefined()
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
  it('attaches one shared actor reference to every diff of the object', async () => {
    const { client } = mockAuditClient({ events: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'A record.ttl' },
      { field: 'A record.proxied' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'obj-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.email).toBe('alice@acme.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'A record.ttl' }]
    await attachDriftActor(client, diffs, { targetId: 'obj-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'obj-1' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix-svc@acme.com' })).toEqual(['veltrix-svc@acme.com'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
