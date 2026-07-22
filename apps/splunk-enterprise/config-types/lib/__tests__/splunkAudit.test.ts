import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  parseAuditResults,
  buildAuditSearch,
  type AuditEvent,
  type DriftActor,
  type SplunkAuditClient,
} from '../splunkAudit'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (index edit). */
const humanChange: AuditEvent = {
  user: 'alice',
  action: 'edit',
  time: '2026-07-20T10:00:00.000+00:00',
  object: 'main',
}

/** The Veltrix service/deploy identity — must be excluded from attribution. */
const veltrixDeploy: AuditEvent = {
  user: 'veltrix-svc',
  action: 'edit',
  time: '2026-07-21T09:00:00.000+00:00',
  object: 'main',
}

/** A more-recent human event that is NOT a change (a search) — deprioritised. */
const humanNonChange: AuditEvent = {
  user: 'alice',
  action: 'search',
  time: '2026-07-21T12:00:00.000+00:00',
  object: 'main',
}

/** Splunk's internal principal — never a human manual change. */
const systemEvent: AuditEvent = {
  user: 'splunk-system-user',
  action: 'edit',
  time: '2026-07-21T13:00:00.000+00:00',
  object: 'main',
}

/**
 * A mock audit client whose `searchExport` returns a canned NDJSON body built
 * from the given events (each wrapped as a `{ result: ... }` line).
 */
function mockAuditClient(
  opts: { ok?: boolean; events?: AuditEvent[]; throwErr?: boolean; body?: string } = {},
): { client: SplunkAuditClient; calls: Array<{ search: string; params: Record<string, string> }> } {
  const ok = opts.ok ?? true
  const calls: Array<{ search: string; params: Record<string, string> }> = []
  const body =
    opts.body ??
    (opts.events ?? [])
      .map((e) => JSON.stringify({ preview: false, result: { _time: e.time, user: e.user, action: e.action, object: e.object } }))
      .join('\n')
  const client: SplunkAuditClient = {
    searchExport: async (search, params) => {
      calls.push({ search, params })
      if (opts.throwErr) throw new Error('network down')
      return { ok, body: ok ? body : '' }
    },
  }
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'splunk-audit',
      name: 'alice',
      at: '2026-07-20T10:00:00.000+00:00',
      eventType: 'edit',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login and attributes the human change instead', () => {
    // Veltrix event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixDeploy, humanChange], ['veltrix-svc'])
    expect(actor).toBeDefined()
    expect(actor?.name).toBe('alice')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['veltrix-svc'])).toBeUndefined()
  })

  it('excludes the Veltrix login case-insensitively', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['VELTRIX-SVC'])).toBeUndefined()
  })

  it('prefers a change-type action over a more-recent read (search) event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('edit')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: AuditEvent = { ...humanNonChange, time: '2026-07-19T00:00:00.000+00:00' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000+00:00')
    expect(actor?.eventType).toBe('search')
  })

  it('ignores Splunk internal principals (splunk-system-user)', () => {
    expect(pickActorFromEvents([systemEvent], [])).toBeUndefined()
  })
})

// --- buildAuditSearch ---------------------------------------------------------

describe('buildAuditSearch', () => {
  it('keys the search on the object NAME in the _audit index', () => {
    const spl = buildAuditSearch('main')
    expect(spl).toContain('index=_audit')
    expect(spl).toContain('object="main"')
    expect(spl).toContain('table _time user action object')
  })

  it('escapes double quotes in the object name', () => {
    const spl = buildAuditSearch('weird"name')
    expect(spl).toContain('object="weird\\"name"')
  })
})

// --- parseAuditResults --------------------------------------------------------

describe('parseAuditResults', () => {
  it('extracts result rows from newline-delimited JSON', () => {
    const body = [
      JSON.stringify({ preview: false, result: { _time: 't1', user: 'alice', action: 'edit', object: 'main' } }),
      JSON.stringify({ preview: false, result: { _time: 't2', user: 'bob', action: 'delete', object: 'main' } }),
    ].join('\n')
    const events = parseAuditResults(body)
    expect(events).toHaveLength(2)
    expect(events[0].user).toBe('alice')
    expect(events[1].action).toBe('delete')
  })

  it('tolerates blank lines and malformed / non-result lines', () => {
    const body = ['', 'not-json', JSON.stringify({ messages: [] }), JSON.stringify({ result: { user: 'carol', _time: 't', action: 'create', object: 'main' } })].join('\n')
    const events = parseAuditResults(body)
    expect(events).toHaveLength(1)
    expect(events[0].user).toBe('carol')
  })

  it('returns an empty list for an empty body', () => {
    expect(parseAuditResults('')).toEqual([])
    expect(parseAuditResults('   ')).toEqual([])
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor keyed on the object name', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { objectName: 'main', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice')
    expect(calls[0].search).toContain('object="main"')
    expect(calls[0].params.output_mode).toBe('json')
    expect(calls[0].params.earliest_time).toBe('-7d')
  })

  it('returns undefined for a Veltrix-only log', async () => {
    const { client } = mockAuditClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, { objectName: 'main', excludeActorLogins: ['veltrix-svc'] })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty result set', async () => {
    const { client } = mockAuditClient({ events: [] })
    expect(await resolveDriftActor(client, { objectName: 'main' })).toBeUndefined()
  })

  it('returns undefined on a not-ok response (best-effort)', async () => {
    const { client } = mockAuditClient({ ok: false, events: [humanChange] })
    expect(await resolveDriftActor(client, { objectName: 'main' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    let result: DriftActor | undefined
    let threw = false
    try {
      result = await resolveDriftActor(client, { objectName: 'main' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })

  it('makes no request and returns undefined when no object name is given', async () => {
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
      { field: 'main.state' },
      { field: 'main.version' },
    ]
    await attachDriftActor(client, diffs, { objectName: 'main', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'main.state' }]
    await attachDriftActor(client, diffs, { objectName: 'main' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    await attachDriftActor(client, [], { objectName: 'main' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix-svc' })).toEqual(['veltrix-svc'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
