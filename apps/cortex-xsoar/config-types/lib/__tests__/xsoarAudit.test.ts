import {
  pickActorFromEvents,
  pickActorFromResource,
  parseAuditEntries,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type XsoarAuditEntry,
  type DriftActor,
} from '../xsoarAudit'
import type { XsoarClient } from '../../../lib/xsoar'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (update) to the "Allowlist" list. */
const humanChange: XsoarAuditEntry = {
  user: 'alice',
  userName: 'Alice Analyst',
  created: '2026-07-20T10:00:00Z',
  action: 'update',
  entity: 'list',
  entityName: 'Allowlist',
}

/** The Veltrix service identity — must be excluded from attribution. */
const veltrixChange: XsoarAuditEntry = {
  user: 'veltrix-svc',
  userName: 'Veltrix Service',
  created: '2026-07-21T09:00:00Z',
  action: 'update',
  entity: 'list',
  entityName: 'Allowlist',
}

/** A more-recent human event that is NOT a change (a login) — deprioritised. */
const humanNonChange: XsoarAuditEntry = {
  user: 'alice',
  userName: 'Alice Analyst',
  created: '2026-07-21T12:00:00Z',
  action: 'login',
  entity: 'list',
  entityName: 'Allowlist',
}

/** XSOAR's automation user ("DBot") — a system actor, never attributable. */
const systemEvent: XsoarAuditEntry = {
  user: 'DBot',
  userName: 'DBot',
  created: '2026-07-21T13:00:00Z',
  action: 'update',
  entity: 'list',
  entityName: 'Allowlist',
}

/** A human change to a DIFFERENT object — must not be correlated to "Allowlist". */
const otherObjectChange: XsoarAuditEntry = {
  user: 'mallory',
  userName: 'Mallory',
  created: '2026-07-22T08:00:00Z',
  action: 'update',
  entity: 'list',
  entityName: 'Blocklist',
}

/** A mock XsoarClient whose `request` returns a canned audit page. */
function mockAuditClient(
  opts: { ok?: boolean; status?: number; entries?: XsoarAuditEntry[]; throwErr?: boolean; body?: string } = {},
): {
  client: XsoarClient
  calls: Array<{ method: string; path: string; body: unknown }>
} {
  const ok = opts.ok ?? true
  const status = opts.status ?? (ok ? 200 : 403)
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const client = {
    request: async (method: string, path: string, o?: { body?: unknown }) => {
      calls.push({ method, path, body: o?.body })
      if (opts.throwErr) throw new Error('network down')
      const body = opts.body ?? JSON.stringify({ total: (opts.entries ?? []).length, audits: opts.entries ?? [] })
      return { status, ok, body }
    },
  } as unknown as XsoarClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'xsoar-audit',
      id: 'alice',
      name: 'Alice Analyst',
      at: '2026-07-20T10:00:00Z',
      eventType: 'update',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login and attributes the human change instead', () => {
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['veltrix-svc'])
    expect(actor).toBeDefined()
    expect(actor?.name).toBe('Alice Analyst')
  })

  it('excludes the Veltrix login by display name too', () => {
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['Veltrix Service'])
    expect(actor?.name).toBe('Alice Analyst')
  })

  it('returns undefined when the only events are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixChange], ['veltrix-svc'])).toBeUndefined()
  })

  it('excludes Veltrix case-insensitively', () => {
    expect(pickActorFromEvents([veltrixChange], ['VELTRIX-SVC'])).toBeUndefined()
  })

  it('prefers a change-type event over a more-recent non-change human event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('update')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: XsoarAuditEntry = { ...humanNonChange, created: '2026-07-19T00:00:00Z' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00Z')
    expect(actor?.eventType).toBe('login')
  })

  it('ignores the DBot system actor', () => {
    expect(pickActorFromEvents([systemEvent], [])).toBeUndefined()
  })

  it('ignores an entry with no named actor', () => {
    expect(pickActorFromEvents([{ action: 'update', entityName: 'Allowlist' }], [])).toBeUndefined()
  })
})

// --- pickActorFromResource (pure) --------------------------------------------

describe('pickActorFromResource', () => {
  it('resolves the modifier from a live object modifiedBy field', () => {
    const actor = pickActorFromResource({ name: 'Allowlist', modifiedBy: 'bob', modified: '2026-07-20T08:00:00Z' })
    expect(actor).toEqual({ source: 'xsoar-audit', name: 'bob', eventType: 'modified', at: '2026-07-20T08:00:00Z' })
  })

  it('returns undefined when there is no modifier field', () => {
    expect(pickActorFromResource({ name: 'Allowlist' })).toBeUndefined()
  })

  it('returns undefined for a nullish resource', () => {
    expect(pickActorFromResource(null)).toBeUndefined()
    expect(pickActorFromResource(undefined)).toBeUndefined()
  })

  it('returns undefined when the modifier is the DBot system user', () => {
    expect(pickActorFromResource({ modifiedBy: 'DBot' })).toBeUndefined()
  })

  it('returns undefined when the modifier is the excluded Veltrix login', () => {
    expect(pickActorFromResource({ modifiedBy: 'veltrix-svc' }, ['veltrix-svc'])).toBeUndefined()
  })
})

// --- parseAuditEntries --------------------------------------------------------

describe('parseAuditEntries', () => {
  it('reads a bare array', () => {
    expect(parseAuditEntries(JSON.stringify([humanChange]))).toHaveLength(1)
  })

  it('reads an { audits } envelope', () => {
    expect(parseAuditEntries(JSON.stringify({ total: 1, audits: [humanChange] }))).toHaveLength(1)
  })

  it('reads a { data } envelope', () => {
    expect(parseAuditEntries(JSON.stringify({ data: [humanChange] }))).toHaveLength(1)
  })

  it('returns an empty list for malformed or unexpected bodies', () => {
    expect(parseAuditEntries('not-json')).toHaveLength(0)
    expect(parseAuditEntries('')).toHaveLength(0)
    expect(parseAuditEntries(JSON.stringify({ nope: true }))).toHaveLength(0)
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by entity name (targetName)', async () => {
    const { client, calls } = mockAuditClient({ entries: [humanChange] })
    const actor = await resolveDriftActor(client, { targetName: 'Allowlist', excludeActorLogins: [] })
    expect(actor?.name).toBe('Alice Analyst')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/settings/audits')
  })

  it('prefers the object own modifiedBy over the audit trail (no request)', async () => {
    const { client, calls } = mockAuditClient({ entries: [humanChange] })
    const actor = await resolveDriftActor(client, {
      targetName: 'Allowlist',
      resource: { name: 'Allowlist', modifiedBy: 'carol' },
    })
    expect(actor?.name).toBe('carol')
    expect(calls).toHaveLength(0)
  })

  it('falls back to the audit trail when the modifier is Veltrix', async () => {
    const { client, calls } = mockAuditClient({ entries: [humanChange] })
    const actor = await resolveDriftActor(client, {
      targetName: 'Allowlist',
      resource: { modifiedBy: 'veltrix-svc' },
      excludeActorLogins: ['veltrix-svc'],
    })
    expect(actor?.name).toBe('Alice Analyst')
    expect(calls).toHaveLength(1)
  })

  it('does NOT correlate an unrelated object change to the target', async () => {
    const { client } = mockAuditClient({ entries: [otherObjectChange] })
    expect(await resolveDriftActor(client, { targetName: 'Allowlist' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only correlated log', async () => {
    const { client } = mockAuditClient({ entries: [veltrixChange] })
    const actor = await resolveDriftActor(client, {
      targetName: 'Allowlist',
      excludeActorLogins: ['veltrix-svc'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockAuditClient({ entries: [] })
    expect(await resolveDriftActor(client, { targetName: 'Allowlist' })).toBeUndefined()
  })

  it('returns undefined on a non-OK response (e.g. key lacks audit permission)', async () => {
    const { client } = mockAuditClient({ ok: false, status: 403, entries: [humanChange] })
    expect(await resolveDriftActor(client, { targetName: 'Allowlist' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockAuditClient({ throwErr: true })
    let result: DriftActor | undefined = { source: 'sentinel' }
    try {
      result = await resolveDriftActor(client, { targetName: 'Allowlist' })
    } catch {
      result = { source: 'threw' }
    }
    expect(result).toBeUndefined()
  })

  it('returns undefined on a malformed body', async () => {
    const { client } = mockAuditClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { targetName: 'Allowlist' })).toBeUndefined()
  })

  it('makes no request and returns undefined when no id, name or resource is given', async () => {
    const { client, calls } = mockAuditClient({ entries: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', async () => {
    const { client } = mockAuditClient({ entries: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'Allowlist.type' },
      { field: 'Allowlist.data' },
    ]
    await attachDriftActor(client, diffs, { targetName: 'Allowlist', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('Alice Analyst')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockAuditClient({ entries: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'Allowlist.type' }]
    await attachDriftActor(client, diffs, { targetName: 'Allowlist' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockAuditClient({ entries: [humanChange] })
    await attachDriftActor(client, [], { targetName: 'Allowlist' })
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
