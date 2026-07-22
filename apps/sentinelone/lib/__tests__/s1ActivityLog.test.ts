import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type S1Activity,
  type DriftActor,
} from '../s1ActivityLog'
import type { S1Client } from '../s1'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (group update) — the attributable case. */
const humanChange: S1Activity = {
  id: 'act-1',
  activityType: 5021,
  createdAt: '2026-07-20T10:00:00.000Z',
  primaryDescription: "Group 'Servers' was updated by Alice Admin.",
  userId: 'u-alice',
  data: { username: 'Alice Admin', groupName: 'Servers', groupId: 'grp-1' },
  groupId: 'grp-1',
  siteId: 'site-1',
}

/** The Veltrix deploy — performed by the connection's service user. */
const veltrixDeploy: S1Activity = {
  id: 'act-2',
  activityType: 5021,
  createdAt: '2026-07-21T09:00:00.000Z',
  primaryDescription: "Group 'Servers' was updated by Veltrix Provisioner.",
  userId: 'u-veltrix',
  data: { username: 'Veltrix Provisioner', groupName: 'Servers', groupId: 'grp-1' },
  groupId: 'grp-1',
}

/** A more-recent human event that is NOT a change (a login) — should be deprioritised. */
const humanRead: S1Activity = {
  id: 'act-3',
  createdAt: '2026-07-21T12:00:00.000Z',
  primaryDescription: 'Alice Admin logged in.',
  userId: 'u-alice',
  data: { username: 'Alice Admin', groupId: 'grp-1' },
  groupId: 'grp-1',
}

/** A system/agent activity with no acting user — never attributable. */
const systemActivity: S1Activity = {
  id: 'act-4',
  createdAt: '2026-07-21T13:00:00.000Z',
  primaryDescription: 'Agent updated automatically.',
  userId: null,
  data: { groupId: 'grp-1' },
  groupId: 'grp-1',
}

/** A human change to a DIFFERENT group — must never be attributed to grp-1. */
const unrelatedChange: S1Activity = {
  id: 'act-5',
  createdAt: '2026-07-21T14:00:00.000Z',
  primaryDescription: "Group 'Workstations' was updated by Bob.",
  userId: 'u-bob',
  data: { username: 'Bob', groupName: 'Workstations', groupId: 'grp-OTHER' },
  groupId: 'grp-OTHER',
}

/** A change whose actor display name is an email — the email field is populated. */
const humanChangeEmail: S1Activity = {
  ...humanChange,
  id: 'act-6',
  data: { username: 'alice@corp.com', groupName: 'Servers', groupId: 'grp-1' },
}

/** A change with an acting user id but no display name in the payload. */
const humanChangeNoName: S1Activity = {
  id: 'act-7',
  activityType: 5021,
  createdAt: '2026-07-20T08:00:00.000Z',
  primaryDescription: 'Exclusion created.',
  userId: 'u-carol',
  data: { value: '/tmp/x' },
}

/** A mock S1Client whose `request` returns a canned Activities envelope. */
function mockActivityClient(
  opts: { status?: number; activities?: S1Activity[]; throwErr?: boolean; body?: string } = {},
): {
  client: S1Client
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    request: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ data: opts.activities ?? [] })
      return { status, ok: status >= 200 && status < 300, body }
    },
  } as unknown as S1Client
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'sentinelone-audit',
      id: 'u-alice',
      name: 'Alice Admin',
      at: '2026-07-20T10:00:00.000Z',
      eventType: "Group 'Servers' was updated by Alice Admin.",
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('ignores a system (non-human) activity', () => {
    expect(pickActorFromEvents([systemActivity], [])).toBeUndefined()
  })

  it('returns undefined when the only events are Veltrix deploys (by name)', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['Veltrix Provisioner'])).toBeUndefined()
  })

  it('excludes the Veltrix identity by acting user id too', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['u-veltrix'])).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively by name', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['VELTRIX PROVISIONER'])).toBeUndefined()
  })

  it('excludes the Veltrix deploy and attributes the real human change', () => {
    // veltrixDeploy is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixDeploy, humanChange], ['Veltrix Provisioner'])
    expect(actor).toBeDefined()
    expect(actor?.name).toBe('Alice Admin')
  })

  it('prefers a change event over a more-recent non-change (login) human event', () => {
    const actor = pickActorFromEvents([humanRead, humanChange], [])
    expect(actor?.at).toBe('2026-07-20T10:00:00.000Z')
    expect(actor?.eventType).toBe("Group 'Servers' was updated by Alice Admin.")
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const olderRead: S1Activity = { ...humanRead, id: 'act-old', createdAt: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([olderRead, humanRead], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
  })

  it('populates the email field when the actor display name is an email', () => {
    const actor = pickActorFromEvents([humanChangeEmail], [])
    expect(actor?.name).toBe('alice@corp.com')
    expect(actor?.email).toBe('alice@corp.com')
  })

  it('falls back to the user id as the name when no display name is present', () => {
    const actor = pickActorFromEvents([humanChangeNoName], [])
    expect(actor?.id).toBe('u-carol')
    expect(actor?.name).toBe('u-carol')
    expect(actor?.email).toBeUndefined()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by the object name/value', async () => {
    const { client, calls } = mockActivityClient({ activities: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Servers', excludeActorLogins: [] })
    expect(actor?.name).toBe('Alice Admin')
    expect(calls[0].path).toBe('/activities')
    expect(calls[0].query.sortBy).toBe('createdAt')
    expect(calls[0].query.sortOrder).toBe('desc')
    expect(calls[0].query.limit).toBe(50)
    expect(calls[0].query.createdAt__gte).toBeDefined()
  })

  it('resolves a human actor correlated by the object id', async () => {
    const { client } = mockActivityClient({ activities: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'grp-1' })
    expect(actor?.name).toBe('Alice Admin')
  })

  it('does not attribute an unrelated object (client-side correlation)', async () => {
    const { client } = mockActivityClient({ activities: [unrelatedChange] })
    expect(await resolveDriftActor(client, { targetId: 'grp-1' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only log', async () => {
    const { client } = mockActivityClient({ activities: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, { targetId: 'grp-1', excludeActorLogins: ['Veltrix Provisioner'] })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockActivityClient({ activities: [] })
    expect(await resolveDriftActor(client, { targetId: 'grp-1' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const { client } = mockActivityClient({ status: 403, activities: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: 'grp-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockActivityClient({ throwErr: true })
    let result: DriftActor | undefined
    let threw = false
    try {
      result = await resolveDriftActor(client, { targetId: 'grp-1' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockActivityClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: 'grp-1' })).toBeUndefined()
  })

  it('makes no request and returns undefined when neither id nor name is given', async () => {
    const { client, calls } = mockActivityClient({ activities: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', async () => {
    const { client } = mockActivityClient({ activities: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'Servers.description' },
      { field: 'Servers.inherits' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'grp-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('Alice Admin')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockActivityClient({ activities: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Servers.description' }]
    await attachDriftActor(client, diffs, { targetId: 'grp-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockActivityClient({ activities: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'grp-1' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection service-user name when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix-svc' })).toEqual(['veltrix-svc'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
