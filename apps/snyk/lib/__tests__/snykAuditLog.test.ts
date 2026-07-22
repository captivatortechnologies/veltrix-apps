import {
  pickActorFromEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type SnykAuditEvent,
  type DriftActor,
} from '../snykAuditLog'
import type { SnykClient } from '../snyk'

// --- Fixtures -----------------------------------------------------------------

/** A human admin editing an integration (a managed change), correlatable by int id. */
const humanChange: SnykAuditEvent = {
  userId: 'u-alice',
  user_email: 'alice@acme.io',
  created: '2026-07-20T10:00:00.000Z',
  event: 'org.integration.edit',
  content: { integration: { id: 'int-1', type: 'github' } },
}

/** The Veltrix deploy — acted by the connection's service-account identity. */
const veltrixDeploy: SnykAuditEvent = {
  userId: 'veltrix-sa',
  created: '2026-07-21T09:00:00.000Z',
  event: 'org.integration.edit',
  content: { integration: { id: 'int-1', type: 'github' } },
}

/** A more-recent human event that is NOT a change (a read) — should be deprioritised. */
const humanRead: SnykAuditEvent = {
  userId: 'u-alice',
  created: '2026-07-21T12:00:00.000Z',
  event: 'org.audit_logs.view',
  content: { integration: { id: 'int-1' } },
}

/** A system event with no resolvable acting user — never attributable. */
const systemEvent: SnykAuditEvent = {
  created: '2026-07-21T13:00:00.000Z',
  event: 'org.project.monitor',
  content: {},
}

/** A mock SnykClient whose `rest` returns a canned audit_logs/search page. */
function mockAuditClient(
  opts: { status?: number; events?: SnykAuditEvent[]; throwErr?: boolean; body?: string } = {},
): {
  client: SnykClient
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = []
  const client = {
    restOrgPath: () => '/orgs/org-1',
    rest: async (method: string, path: string, o?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path, query: o?.query ?? {} })
      if (opts.throwErr) throw new Error('network down')
      const body =
        opts.body ?? JSON.stringify({ jsonapi: { version: '1.0' }, data: { items: opts.events ?? [] } })
      return { status, ok: status >= 200 && status < 300, body }
    },
  } as unknown as SnykClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'snyk-audit',
      id: 'u-alice',
      name: 'alice@acme.io',
      email: 'alice@acme.io',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'org.integration.edit',
    })
  })

  it('falls back to the acting user id as the name when no email/name is present', () => {
    const actor = pickActorFromEvents(
      [{ userId: 'u-bob', created: '2026-07-20T10:00:00.000Z', event: 'org.webhook.remove' }],
      [],
    )
    expect(actor).toEqual({
      source: 'snyk-audit',
      id: 'u-bob',
      name: 'u-bob',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'org.webhook.remove',
    })
  })

  it('reads the acting user from the user_public_id key', () => {
    const actor = pickActorFromEvents(
      [{ user_public_id: 'pub-1', created: '2026-07-20T10:00:00.000Z', event: 'org.settings.edit' }],
      [],
    )
    expect(actor?.id).toBe('pub-1')
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('ignores a system event with no resolvable acting user', () => {
    expect(pickActorFromEvents([systemEvent], [])).toBeUndefined()
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['veltrix-sa'])).toBeUndefined()
  })

  it('excludes a more-recent Veltrix event and attributes the real human change', () => {
    const actor = pickActorFromEvents([veltrixDeploy, humanChange], ['veltrix-sa'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.io')
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    expect(pickActorFromEvents([veltrixDeploy], ['VELTRIX-SA'])).toBeUndefined()
  })

  it('prefers a change event over a more-recent read by the same human', () => {
    const actor = pickActorFromEvents([humanRead, humanChange], [])
    expect(actor?.eventType).toBe('org.integration.edit')
    expect(actor?.at).toBe('2026-07-20T10:00:00.000Z')
  })

  it('falls back to the most recent event when none is a change type', () => {
    const older: SnykAuditEvent = { ...humanRead, created: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanRead], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('org.audit_logs.view')
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor via the content-correlated query', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'int-1', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@acme.io')
    expect(calls[0].path).toBe('/orgs/org-1/audit_logs/search')
    expect(calls[0].query.sort_order).toBe('DESC')
    expect(calls[0].query.size).toBe(50)
    expect(typeof calls[0].query.from).toBe('string')
  })

  it('returns undefined for a Veltrix-only log', async () => {
    const { client } = mockAuditClient({ events: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, { targetId: 'int-1', excludeActorLogins: ['veltrix-sa'] })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockAuditClient({ events: [] })
    expect(await resolveDriftActor(client, { targetId: 'int-1' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const { client } = mockAuditClient({ status: 403, events: [humanChange] })
    expect(await resolveDriftActor(client, { targetId: 'int-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    let result: DriftActor | undefined
    let threw = false
    try {
      result = await resolveDriftActor(client, { targetId: 'int-1' })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockAuditClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetId: 'int-1' })).toBeUndefined()
  })

  it('correlates by name (URL) when only a targetName is known (deleted object)', async () => {
    const webhookRemove: SnykAuditEvent = {
      userId: 'u-alice',
      user_email: 'alice@acme.io',
      created: '2026-07-20T10:00:00.000Z',
      event: 'org.webhook.remove',
      content: { url: 'https://hooks.example.com/x' },
    }
    const { client } = mockAuditClient({ events: [webhookRemove] })
    const actor = await resolveDriftActor(client, { targetName: 'https://hooks.example.com/x' })
    expect(actor?.email).toBe('alice@acme.io')
  })

  it('does not attribute an unrelated object (client-side content correlation)', async () => {
    const otherInt: SnykAuditEvent = { ...humanChange, content: { integration: { id: 'int-OTHER', type: 'gitlab' } } }
    const { client } = mockAuditClient({ events: [otherInt] })
    expect(await resolveDriftActor(client, { targetId: 'int-1' })).toBeUndefined()
  })

  it('correlates an org-singleton by event prefix', async () => {
    const sastEdit: SnykAuditEvent = {
      userId: 'u-alice',
      user_email: 'alice@acme.io',
      created: '2026-07-20T10:00:00.000Z',
      event: 'org.sast_settings.edit',
      content: {},
    }
    const unrelated: SnykAuditEvent = { userId: 'u-eve', created: '2026-07-21T00:00:00.000Z', event: 'org.member.add' }
    const { client } = mockAuditClient({ events: [unrelated, sastEdit] })
    const actor = await resolveDriftActor(client, { eventPrefixes: ['org.sast_settings'] })
    expect(actor?.email).toBe('alice@acme.io')
  })

  it('makes no request and returns undefined when neither target nor prefixes are given', async () => {
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
      { field: 'github.pullRequestTestEnabled' },
      { field: 'github.autoDepUpgradeEnabled' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'int-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice@acme.io')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ events: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'github.pullRequestTestEnabled' }]
    await attachDriftActor(client, diffs, { targetId: 'int-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ events: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'int-1' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username and display name, de-duplicated', () => {
    expect(veltrixActorLogins({ username: 'veltrix-sa', name: 'Snyk Prod' })).toEqual(['veltrix-sa', 'Snyk Prod'])
  })

  it('collapses a username that equals the display name', () => {
    expect(veltrixActorLogins({ username: 'svc', name: 'svc' })).toEqual(['svc'])
  })

  it('returns an empty list for missing or blank identities', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ', name: null })).toEqual([])
    expect(veltrixActorLogins({})).toEqual([])
  })
})
