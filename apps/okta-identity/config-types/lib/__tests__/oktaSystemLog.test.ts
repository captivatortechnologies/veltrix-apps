import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type SystemLogEvent,
  type DriftActor,
} from '../oktaSystemLog'
import type { OktaClient } from '../../../lib/okta'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (group profile update). */
const humanChange: SystemLogEvent = {
  actor: { id: '00uHuman', displayName: 'Alice Admin', alternateId: 'alice@acme.com', type: 'User' },
  published: '2026-07-20T10:00:00.000Z',
  eventType: 'group.lifecycle.update',
  target: [{ id: '00gGroup', displayName: 'Engineers', type: 'UserGroup' }],
}

/** The Veltrix service/deploy identity — must be excluded from attribution. */
const veltrixDeploy: SystemLogEvent = {
  actor: { id: '00uVeltrix', displayName: 'Veltrix Deploy', alternateId: 'veltrix-svc@acme.com', type: 'User' },
  published: '2026-07-21T09:00:00.000Z',
  eventType: 'group.lifecycle.update',
  target: [{ id: '00gGroup', displayName: 'Engineers', type: 'UserGroup' }],
}

/** A more-recent human event that is NOT a change (a login) — should be deprioritised. */
const humanNonChange: SystemLogEvent = {
  actor: { id: '00uHuman', displayName: 'Alice Admin', alternateId: 'alice@acme.com', type: 'User' },
  published: '2026-07-21T12:00:00.000Z',
  eventType: 'user.session.start',
  target: [{ id: '00gGroup', displayName: 'Engineers', type: 'UserGroup' }],
}

/** A non-human (service/system) actor — never attributable. */
const systemEvent: SystemLogEvent = {
  actor: { id: 'sys', displayName: 'Okta System', alternateId: 'system@okta', type: 'SystemPrincipal' },
  published: '2026-07-21T13:00:00.000Z',
  eventType: 'group.lifecycle.update',
}

/** A mock OktaClient whose `request` returns a canned System Log page. */
function mockLogClient(opts: { status?: number; events?: SystemLogEvent[]; throwErr?: boolean; body?: string } = {}): {
  client: OktaClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    request: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify(opts.events ?? [])
      return { status, ok: status >= 200 && status < 300, body, nextUrl: null }
    },
  } as unknown as OktaClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'okta-system-log',
      id: '00uHuman',
      name: 'Alice Admin',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'group.lifecycle.update',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login and attributes the human change instead', () => {
    // Veltrix event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixDeploy, humanChange], ['veltrix-svc@acme.com'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['veltrix-svc@acme.com'])).toBeUndefined()
  })

  it('excludes Veltrix by displayName too (case-insensitive)', () => {
    const actor = pickActorFromEvents([veltrixDeploy], ['VELTRIX DEPLOY'])
    expect(actor).toBeUndefined()
  })

  it('prefers a change-type event over a more-recent non-change human event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('group.lifecycle.update')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: SystemLogEvent = { ...humanNonChange, published: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('user.session.start')
  })

  it('ignores non-human (service/system) actors', () => {
    expect(pickActorFromEvents([systemEvent], [])).toBeUndefined()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor via the target.id filter', async () => {
    const { client, calls } = mockLogClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: '00gGroup', excludeActorLogins: [] })
    expect(actor?.name).toBe('Alice Admin')
    expect(calls[0].path).toBe('/logs')
    expect(String(calls[0].query.filter)).toContain('target.id eq "00gGroup"')
    expect(calls[0].query.sortOrder).toBe('DESCENDING')
  })

  it('returns undefined for a Veltrix-only log', async () => {
    const { client } = mockLogClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, {
      targetId: '00gGroup',
      excludeActorLogins: ['veltrix-svc@acme.com'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockLogClient({ events: [] })
    expect(await resolveDriftActor(client, { targetId: '00gGroup' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const { client } = mockLogClient({ status: 429, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: '00gGroup' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockLogClient({ throwErr: true })
    expect(await resolveDriftActor(client, { targetId: '00gGroup' })).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockLogClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: '00gGroup' })).toBeUndefined()
  })

  it('uses a free-text q query when only a targetName is known (deleted object)', async () => {
    const { client, calls } = mockLogClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Engineers', excludeActorLogins: [] })
    expect(actor?.name).toBe('Alice Admin')
    expect(calls[0].query.q).toBe('Engineers')
    expect(calls[0].query.filter).toBeUndefined()
  })

  it('makes no request and returns undefined when neither id nor name is given', async () => {
    const { client, calls } = mockLogClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', async () => {
    const { client } = mockLogClient({ events: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'Engineers.description' },
      { field: 'Engineers.members' },
    ]
    await attachDriftActor(client, diffs, { targetId: '00gGroup', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('Alice Admin')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockLogClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Engineers.description' }]
    await attachDriftActor(client, diffs, { targetId: '00gGroup' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockLogClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetId: '00gGroup' })
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
