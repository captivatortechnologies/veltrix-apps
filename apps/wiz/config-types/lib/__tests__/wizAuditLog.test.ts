import {
  pickActorFromEvents,
  eventMatchesTarget,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type WizAuditEvent,
  type DriftActor,
} from '../wizAuditLog'
import type { WizClient } from '../../../lib/wiz'

// --- Fixtures -----------------------------------------------------------------

/** A human admin making a managed change (rule update); its input names rule-123. */
const humanChange: WizAuditEvent = {
  id: 'evt-1',
  action: 'UpdateCloudConfigurationRule',
  status: 'SUCCESS',
  timestamp: '2026-07-20T10:00:00.000Z',
  actionParameters: { input: { id: 'rule-123', patch: { severity: 'HIGH' } } },
  user: { id: 'u-alice', name: 'Alice Admin', email: 'alice@acme.com' },
  serviceAccount: null,
}

/** Veltrix's own deploy — a SERVICE ACCOUNT action (no `user`); never a human actor. */
const veltrixDeploy: WizAuditEvent = {
  id: 'evt-2',
  action: 'UpdateCloudConfigurationRule',
  status: 'SUCCESS',
  timestamp: '2026-07-21T09:00:00.000Z',
  actionParameters: { input: { id: 'rule-123' } },
  user: null,
  serviceAccount: { id: 'veltrix-sa', name: 'veltrix-deploy' },
}

/** A more-recent human change performed under the Veltrix identity — excluded by login. */
const veltrixHuman: WizAuditEvent = {
  ...humanChange,
  id: 'evt-3',
  timestamp: '2026-07-22T08:00:00.000Z',
  user: { id: 'veltrix-client-id', name: 'Veltrix Deploy', email: 'veltrix-svc@acme.com' },
}

/** A more-recent human event that is NOT a change (a read) — should be deprioritised. */
const humanNonChange: WizAuditEvent = {
  id: 'evt-4',
  action: 'GetCloudConfigurationRule',
  status: 'SUCCESS',
  timestamp: '2026-07-21T12:00:00.000Z',
  actionParameters: { id: 'rule-123' },
  user: { id: 'u-alice', name: 'Alice Admin', email: 'alice@acme.com' },
  serviceAccount: null,
}

/** A non-human (service-account only) actor — never attributable. */
const serviceOnly: WizAuditEvent = {
  id: 'evt-5',
  action: 'UpdateCloudConfigurationRule',
  timestamp: '2026-07-21T13:00:00.000Z',
  actionParameters: { input: { id: 'rule-123' } },
  user: null,
  serviceAccount: { id: 'sa-x', name: 'ci-runner' },
}

/** A mock WizClient whose `graphql` returns a canned audit-log page. */
function mockWizClient(
  opts: {
    nodes?: WizAuditEvent[]
    transportError?: string | null
    errors?: unknown
    data?: unknown
    throwErr?: boolean
  } = {},
): { client: WizClient; calls: Array<{ query: string; variables: Record<string, unknown> }> } {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const client = {
    graphql: async (query: string, variables: Record<string, unknown> = {}) => {
      calls.push({ query, variables })
      if (opts.throwErr) throw new Error('network down')
      return {
        status: 200,
        data:
          opts.data !== undefined ? opts.data : { auditLogEntries: { nodes: opts.nodes ?? [] } },
        errors: opts.errors ?? null,
        transportError: opts.transportError ?? null,
      }
    },
  } as unknown as WizClient
  return { client, calls }
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change event', () => {
    const actor = pickActorFromEvents([humanChange], [])
    expect(actor).toEqual({
      source: 'wiz-audit',
      id: 'u-alice',
      name: 'Alice Admin',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00.000Z',
      eventType: 'UpdateCloudConfigurationRule',
    })
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login (by user email) and attributes the human change instead', () => {
    // The Veltrix human event is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixHuman, humanChange], ['veltrix-svc@acme.com'])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('returns undefined when the only events are Veltrix changes', () => {
    expect(pickActorFromEvents([veltrixHuman], ['veltrix-svc@acme.com'])).toBeUndefined()
  })

  it('excludes Veltrix by user name too (case-insensitive)', () => {
    expect(pickActorFromEvents([veltrixHuman], ['VELTRIX DEPLOY'])).toBeUndefined()
  })

  it('excludes a human whose serviceAccount identity is in the exclude list', () => {
    const humanWithVeltrixSa: WizAuditEvent = {
      ...humanChange,
      id: 'evt-6',
      serviceAccount: { id: 'veltrix-sa-id', name: 'veltrix' },
    }
    expect(pickActorFromEvents([humanWithVeltrixSa], ['veltrix-sa-id'])).toBeUndefined()
  })

  it('prefers a change-type action over a more-recent non-change human event', () => {
    const actor = pickActorFromEvents([humanNonChange, humanChange], [])
    expect(actor?.eventType).toBe('UpdateCloudConfigurationRule')
  })

  it('falls back to the most recent human event when none is a change type', () => {
    const older: WizAuditEvent = { ...humanNonChange, id: 'evt-7', timestamp: '2026-07-19T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanNonChange], [])
    expect(actor?.at).toBe('2026-07-21T12:00:00.000Z')
    expect(actor?.eventType).toBe('GetCloudConfigurationRule')
  })

  it('ignores non-human (service-account only) actors', () => {
    expect(pickActorFromEvents([serviceOnly], [])).toBeUndefined()
  })
})

// --- eventMatchesTarget (pure correlation) -----------------------------------

describe('eventMatchesTarget', () => {
  it('matches the target id inside an object actionParameters', () => {
    expect(eventMatchesTarget(humanChange, { targetId: 'rule-123' })).toBe(true)
  })

  it('does not match a different id', () => {
    expect(eventMatchesTarget(humanChange, { targetId: 'rule-999' })).toBe(false)
  })

  it('matches the target name (case-insensitive) inside actionParameters', () => {
    const created: WizAuditEvent = {
      action: 'CreateServiceAccount',
      timestamp: '2026-07-20T10:00:00.000Z',
      actionParameters: { input: { name: 'CI Readonly' } },
      user: { id: 'u-bob', name: 'Bob' },
    }
    expect(eventMatchesTarget(created, { targetName: 'ci readonly' })).toBe(true)
  })

  it('matches an id inside an already-serialized (string) actionParameters', () => {
    const event: WizAuditEvent = { action: 'DeleteServiceAccount', actionParameters: '{"id":"rule-123"}' }
    expect(eventMatchesTarget(event, { targetId: 'rule-123' })).toBe(true)
  })

  it('returns false when no target key is supplied', () => {
    expect(eventMatchesTarget(humanChange, {})).toBe(false)
  })

  it('does not throw on undefined actionParameters', () => {
    const event: WizAuditEvent = { action: 'UpdateCloudConfigurationRule' }
    expect(eventMatchesTarget(event, { targetId: 'rule-123' })).toBe(false)
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor correlated by id and sends a timestamp filter', async () => {
    const { client, calls } = mockWizClient({ nodes: [humanChange] })
    const actor = await resolveDriftActor(client, { targetId: 'rule-123', excludeActorLogins: [] })
    expect(actor?.name).toBe('Alice Admin')
    expect(calls).toHaveLength(1)
    expect(calls[0].variables.first).toBe(50)
    const filterBy = calls[0].variables.filterBy as { timestamp?: { after?: string } }
    expect(filterBy.timestamp?.after).toBeDefined()
  })

  it('ignores audit entries that do not correlate to the target', async () => {
    const other: WizAuditEvent = { ...humanChange, id: 'evt-x', actionParameters: { input: { id: 'other-rule' } } }
    const { client } = mockWizClient({ nodes: [other] })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('returns undefined for a Veltrix-only (service account) log', async () => {
    const { client } = mockWizClient({ nodes: [veltrixDeploy] })
    const actor = await resolveDriftActor(client, {
      targetId: 'rule-123',
      excludeActorLogins: ['veltrix-deploy'],
    })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for an empty log', async () => {
    const { client } = mockWizClient({ nodes: [] })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('returns undefined on a transport error (best-effort)', async () => {
    const { client } = mockWizClient({ transportError: 'HTTP 403: forbidden' })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('returns undefined on GraphQL errors (e.g. audit scope unavailable)', async () => {
    const { client } = mockWizClient({ errors: [{ message: 'auditLogEntries not permitted' }] })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockWizClient({ throwErr: true })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('returns undefined when the response has no nodes', async () => {
    const { client } = mockWizClient({ data: { auditLogEntries: null } })
    expect(await resolveDriftActor(client, { targetId: 'rule-123' })).toBeUndefined()
  })

  it('makes no request and returns undefined when neither id nor name is given', async () => {
    const { client, calls } = mockWizClient({ nodes: [humanChange] })
    const actor = await resolveDriftActor(client, {})
    expect(actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', async () => {
    const { client } = mockWizClient({ nodes: [humanChange] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'rule.severity' },
      { field: 'rule.enabled' },
    ]
    await attachDriftActor(client, diffs, { targetId: 'rule-123', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('Alice Admin')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockWizClient({ nodes: [] })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'rule.severity' }]
    await attachDriftActor(client, diffs, { targetId: 'rule-123' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op (no query) when there are no diffs', async () => {
    const { client, calls } = mockWizClient({ nodes: [humanChange] })
    await attachDriftActor(client, [], { targetId: 'rule-123' })
    expect(calls).toHaveLength(0)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username (the Wiz client id) when present', () => {
    expect(veltrixActorLogins({ username: 'wiz-client-id' })).toEqual(['wiz-client-id'])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
