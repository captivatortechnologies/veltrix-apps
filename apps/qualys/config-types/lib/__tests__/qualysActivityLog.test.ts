import {
  pickActorFromEvents,
  parseActivityEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  ACTIVITY_LOG_PATH,
  type QualysActivityEvent,
  type DriftActor,
} from '../qualysActivityLog'
import type { QualysClient, QualysParams, QualysResponse } from '../../../lib/qualys'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (update) to the "Web Tier" group. */
const humanChange: QualysActivityEvent = {
  user: 'alice',
  date: '2026-07-20T10:00:00Z',
  action: 'update',
  module: 'assets',
  details: 'Asset group "Web Tier" was updated',
}

/** The Veltrix service account — must be excluded from attribution. */
const veltrixChange: QualysActivityEvent = {
  user: 'veltrix_svc',
  date: '2026-07-21T09:00:00Z',
  action: 'update',
  module: 'assets',
  details: 'Asset group "Web Tier" was updated',
}

/** A more-recent human event that is NOT a change (a login) — deprioritised. */
const humanNonChange: QualysActivityEvent = {
  user: 'alice',
  date: '2026-07-21T12:00:00Z',
  action: 'login',
  module: 'auth',
  details: 'User logged in — Web Tier dashboard',
}

/** A human event with no acting login — never attributable. */
const noUserEvent: QualysActivityEvent = {
  user: '',
  date: '2026-07-21T13:00:00Z',
  action: 'update',
  module: 'assets',
  details: 'Asset group "Web Tier" was updated',
}

/** A human change to a DIFFERENT object — must not be correlated to "Web Tier". */
const otherObjectChange: QualysActivityEvent = {
  user: 'mallory',
  date: '2026-07-22T08:00:00Z',
  action: 'update',
  module: 'assets',
  details: 'Asset group "DB Tier" was updated',
}

/** A mock QualysClient whose `post` returns a canned activity-log XML page. */
function mockActivityClient(
  opts: { ok?: boolean; status?: number; events?: QualysActivityEvent[]; throwErr?: boolean; body?: string } = {},
): {
  client: QualysClient
  calls: Array<{ path: string; params: QualysParams }>
} {
  const ok = opts.ok ?? true
  const status = opts.status ?? (ok ? 200 : 403)
  const calls: Array<{ path: string; params: QualysParams }> = []
  const client = {
    post: async (path: string, params: QualysParams): Promise<QualysResponse> => {
      calls.push({ path, params })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? buildActivityXml(opts.events ?? [])
      return { status, ok, body }
    },
  } as unknown as QualysClient
  return { client, calls }
}

/** Serialize events to the User Activity Log XML shape the parser reads. */
function buildActivityXml(events: QualysActivityEvent[]): string {
  const blocks = events
    .map(
      (e) =>
        `<USER_ACTIVITY_LOG><DATE>${e.date ?? ''}</DATE><ACTION>${e.action ?? ''}</ACTION>` +
        `<MODULE>${e.module ?? ''}</MODULE><DETAILS><![CDATA[${e.details ?? ''}]]></DETAILS>` +
        `<USER_NAME>${e.user ?? ''}</USER_NAME></USER_ACTIVITY_LOG>`,
    )
    .join('')
  return `<?xml version="1.0"?><USER_ACTIVITY_LOG_LIST_OUTPUT><RESPONSE><USER_ACTIVITY_LOG_LIST>${blocks}</USER_ACTIVITY_LOG_LIST></RESPONSE></USER_ACTIVITY_LOG_LIST_OUTPUT>`
}

// --- parseActivityEvents ------------------------------------------------------

describe('parseActivityEvents', () => {
  it('parses USER_ACTIVITY_LOG blocks into events (CDATA details unwrapped)', () => {
    const events = parseActivityEvents(buildActivityXml([humanChange]))
    expect(events).toHaveLength(1)
    expect(events[0].user).toBe('alice')
    expect(events[0].date).toBe('2026-07-20T10:00:00Z')
    expect(events[0].action).toBe('update')
    expect(events[0].details).toBe('Asset group "Web Tier" was updated')
  })

  it('returns an empty array for a document with no activity blocks', () => {
    expect(parseActivityEvents('<USER_ACTIVITY_LOG_LIST_OUTPUT></USER_ACTIVITY_LOG_LIST_OUTPUT>')).toEqual([])
  })

  it('returns an empty array for malformed input (never throws)', () => {
    expect(parseActivityEvents('not xml at all')).toEqual([])
  })
})

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'qualys-audit',
      name: 'alice',
      at: '2026-07-20T10:00:00Z',
      eventType: 'update',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login and attributes the human change instead', () => {
    // Veltrix event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['veltrix_svc'])
    expect(actor).toBeDefined()
    expect(actor?.name).toBe('alice')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixChange], ['veltrix_svc'])).toBeUndefined()
  })

  it('excludes Veltrix case-insensitively', () => {
    expect(pickActorFromEvents([veltrixChange], ['VELTRIX_SVC'])).toBeUndefined()
  })

  it('prefers a change-type event over a more-recent non-change human event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('update')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: QualysActivityEvent = { ...humanNonChange, date: '2026-07-19T00:00:00Z' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00Z')
    expect(actor?.eventType).toBe('login')
  })

  it('ignores events with no acting login', () => {
    expect(pickActorFromEvents([noUserEvent], [])).toBeUndefined()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by name in the details text', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Web Tier', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice')
    expect(calls[0].path).toBe(ACTIVITY_LOG_PATH)
    expect(calls[0].params.action).toBe('list')
    expect(calls[0].params.output_format).toBe('XML')
    expect(calls[0].params.truncation_limit).toBe(50)
  })

  it('correlates by targetId when the id appears in the details text', async () => {
    const idEvent: QualysActivityEvent = {
      user: 'alice',
      date: '2026-07-20T10:00:00Z',
      action: 'update',
      module: 'assets',
      details: 'Search list id 4021 was updated',
    }
    const { client } = mockActivityClient({ events: [idEvent] })
    const actor = await resolveDriftActor(client, { targetId: '4021' })
    expect(actor?.name).toBe('alice')
  })

  it('does NOT correlate an unrelated object change to the target', async () => {
    const { client } = mockActivityClient({ events: [otherObjectChange] })
    expect(await resolveDriftActor(client, { targetName: 'Web Tier' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only correlated log', async () => {
    const { client } = mockActivityClient({ events: [veltrixChange] })
    const actor = await resolveDriftActor(client, {
      targetName: 'Web Tier',
      excludeActorLogins: ['veltrix_svc'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockActivityClient({ events: [] })
    expect(await resolveDriftActor(client, { targetName: 'Web Tier' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (e.g. account lacks activity-log access)', async () => {
    const { client } = mockActivityClient({ ok: false, status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetName: 'Web Tier' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockActivityClient({ throwErr: true })
    let result: DriftActor | undefined = { source: 'sentinel' }
    result = await resolveDriftActor(client, { targetName: 'Web Tier' })
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockActivityClient({ body: 'not-xml' })
    expect(await resolveDriftActor(client, { targetName: 'Web Tier' })).toBeUndefined()
  })

  it('makes no request and returns undefined when neither id nor name is given', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', async () => {
    const { client } = mockActivityClient({ events: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'Web Tier.comments' },
      { field: 'Web Tier.ips' },
    ]
    await attachDriftActor(client, diffs, { targetName: 'Web Tier', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockActivityClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Web Tier.comments' }]
    await attachDriftActor(client, diffs, { targetName: 'Web Tier' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockActivityClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetName: 'Web Tier' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix_svc' })).toEqual(['veltrix_svc'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
