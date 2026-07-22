import {
  pickActorFromEvents,
  pickActorFromResource,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  epochToIso,
  type AccountActivity,
  type CyberArkResource,
  type DriftActor,
} from '../cyberarkAudit'
import type { CyberArkClient } from '../../../lib/cyberark'

// --- Fixtures -----------------------------------------------------------------

/** Epoch SECONDS — CyberArk activity dates and safe creationTime are in seconds. */
const T_OLD = 1_700_000_000 // 2023-11-14T22:13:20Z
const T_MID = 1_710_000_000 // 2024-03-09T16:00:00Z
const T_NEW = 1_720_000_000 // 2024-07-03T09:46:40Z

/** A human admin modifying an account's properties (a change action). */
const humanChange: AccountActivity = { User: 'alice', Date: T_MID, Action: 'Modify object properties' }

/** The Veltrix service/deploy identity — must be excluded from attribution. */
const veltrixChange: AccountActivity = { User: 'veltrix-svc', Date: T_NEW, Action: 'Update account' }

/** A more-recent human activity that is NOT a change (a retrieval) — deprioritised. */
const humanRetrieve: AccountActivity = { User: 'alice', Date: T_NEW, Action: 'Retrieve password' }

/** An automated CPM rotation — never a human change. */
const cpmChange: AccountActivity = { User: 'PasswordManager', Date: T_NEW, Action: 'CPM Change Password' }

/** A safe carrying its creator + timestamps (resource-embedded attribution). */
const safeResource: CyberArkResource = {
  creator: { id: '9', name: 'bob@acme.com' },
  creationTime: T_OLD,
  lastModificationTime: T_MID,
}

/**
 * A mock CyberArkClient whose `request` returns a canned Activities body.
 */
function mockClient(opts: { status?: number; body?: string; throwErr?: boolean } = {}): {
  client: CyberArkClient
  calls: Array<{ method: string; path: string }>
} {
  const status = opts.status ?? 200
  const calls: Array<{ method: string; path: string }> = []
  const client = {
    request: async (method: string, path: string) => {
      calls.push({ method, path })
      if (opts.throwErr) throw new Error('network down')
      return { status, ok: status >= 200 && status < 300, body: opts.body ?? '[]' }
    },
  } as unknown as CyberArkClient
  return { client, calls }
}

// --- epochToIso (pure) -------------------------------------------------------

describe('epochToIso', () => {
  it('reads a seconds epoch', () => {
    expect(epochToIso(T_OLD)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('reads a milliseconds epoch', () => {
    expect(epochToIso(T_OLD * 1000)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('reads a microseconds epoch', () => {
    expect(epochToIso(T_OLD * 1_000_000)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('returns undefined for a missing / non-positive / non-number value', () => {
    expect(epochToIso(undefined)).toBeUndefined()
    expect(epochToIso(0)).toBeUndefined()
    expect(epochToIso(-5)).toBeUndefined()
    expect(epochToIso('nope')).toBeUndefined()
  })
})

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for a change activity', () => {
    expect(pickActorFromEvents([humanChange], [])).toEqual({
      source: 'cyberark-audit',
      name: 'alice',
      at: '2024-03-09T16:00:00.000Z',
      eventType: 'Modify object properties',
    })
  })

  it('surfaces an email-shaped User as the actor email', () => {
    const actor = pickActorFromEvents([{ User: 'alice@acme.com', Date: T_MID, Action: 'Update account' }], [])
    expect(actor?.email).toBe('alice@acme.com')
    expect(actor?.name).toBe('alice@acme.com')
  })

  it('returns undefined for an empty log', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('excludes the Veltrix login and attributes the human change instead', () => {
    // The Veltrix activity is more recent, but excluded — the human change wins.
    const actor = pickActorFromEvents([veltrixChange, humanChange], ['veltrix-svc'])
    expect(actor).toBeDefined()
    expect(actor?.name).toBe('alice')
  })

  it('returns undefined when the only activities are Veltrix deploys', () => {
    expect(pickActorFromEvents([veltrixChange], ['veltrix-svc'])).toBeUndefined()
  })

  it('excludes Veltrix case-insensitively', () => {
    expect(pickActorFromEvents([veltrixChange], ['VELTRIX-SVC'])).toBeUndefined()
  })

  it('prefers a change activity over a more-recent non-change human activity', () => {
    const actor = pickActorFromEvents([humanRetrieve, humanChange], [])
    expect(actor?.eventType).toBe('Modify object properties')
    expect(actor?.at).toBe('2024-03-09T16:00:00.000Z')
  })

  it('falls back to the most recent human activity when none is a change type', () => {
    const older: AccountActivity = { User: 'alice', Date: T_OLD, Action: 'Retrieve password' }
    const actor = pickActorFromEvents([older, humanRetrieve], [])
    expect(actor?.at).toBe('2024-07-03T09:46:40.000Z')
    expect(actor?.eventType).toBe('Retrieve password')
  })

  it('ignores automated CPM activities', () => {
    expect(pickActorFromEvents([cpmChange], [])).toBeUndefined()
  })

  it('ignores activities with an empty User', () => {
    expect(pickActorFromEvents([{ User: '   ', Date: T_NEW, Action: 'Modify object properties' }], [])).toBeUndefined()
  })
})

// --- pickActorFromResource (pure) --------------------------------------------

describe('pickActorFromResource', () => {
  it('maps a safe creator + lastModificationTime to a fully-populated actor', () => {
    expect(pickActorFromResource(safeResource, [])).toEqual({
      source: 'cyberark-audit',
      name: 'bob@acme.com',
      id: '9',
      email: 'bob@acme.com',
      at: '2024-03-09T16:00:00.000Z',
      eventType: 'safe.modified',
    })
  })

  it('falls back to creationTime + safe.created when there is no modification time', () => {
    const actor = pickActorFromResource({ creator: { name: 'carol' }, creationTime: T_OLD }, [])
    expect(actor).toEqual({
      source: 'cyberark-audit',
      name: 'carol',
      at: '2023-11-14T22:13:20.000Z',
      eventType: 'safe.created',
    })
  })

  it('uses the creator id as the name when no name is present', () => {
    const actor = pickActorFromResource({ creator: { id: 42 }, creationTime: T_OLD }, [])
    expect(actor?.name).toBe('42')
    expect(actor?.id).toBeUndefined()
  })

  it('returns undefined when the creator is the excluded Veltrix login', () => {
    expect(pickActorFromResource({ creator: { name: 'veltrix-svc' }, creationTime: T_OLD }, ['veltrix-svc'])).toBeUndefined()
  })

  it('excludes the Veltrix creator case-insensitively', () => {
    expect(pickActorFromResource({ creator: { name: 'Veltrix-SVC' }, creationTime: T_OLD }, ['veltrix-svc'])).toBeUndefined()
  })

  it('returns undefined when there is no creator', () => {
    expect(pickActorFromResource({ creationTime: T_OLD }, [])).toBeUndefined()
  })

  it('returns undefined for a null / non-object resource', () => {
    expect(pickActorFromResource(null, [])).toBeUndefined()
    expect(pickActorFromResource(undefined, [])).toBeUndefined()
  })

  it('returns undefined for a member-shaped object (no creator metadata)', () => {
    // A live safe member carries permissions/expiration but no creator — "—".
    const member = { memberName: 'app-team', permissions: { useAccounts: true } } as CyberArkResource
    expect(pickActorFromResource(member, [])).toBeUndefined()
  })
})

// --- resolveDriftActor (live query, mocked) ----------------------------------

describe('resolveDriftActor', () => {
  it('resolves an account actor from the Activities log', async () => {
    const { client, calls } = mockClient({ body: JSON.stringify({ Activities: [humanChange] }) })
    const actor = await resolveDriftActor(client, { accountId: 'acc-1', excludeActorLogins: [] })
    expect(actor?.name).toBe('alice')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path).toBe('/Accounts/acc-1/Activities')
  })

  it('unwraps the GetAccountActivitiesResult envelope variant', async () => {
    const { client } = mockClient({ body: JSON.stringify({ GetAccountActivitiesResult: [humanChange] }) })
    expect((await resolveDriftActor(client, { accountId: 'acc-1' }))?.name).toBe('alice')
  })

  it('unwraps a bare activities array', async () => {
    const { client } = mockClient({ body: JSON.stringify([humanChange]) })
    expect((await resolveDriftActor(client, { accountId: 'acc-1' }))?.name).toBe('alice')
  })

  it('resolves a safe actor from the resource without any API call', async () => {
    const { client, calls } = mockClient({ body: 'unused' })
    const actor = await resolveDriftActor(client, { resource: safeResource, excludeActorLogins: [] })
    expect(actor?.name).toBe('bob@acme.com')
    expect(calls).toHaveLength(0)
  })

  it('returns undefined on a non-OK Activities response (best-effort)', async () => {
    const { client } = mockClient({ status: 403, body: JSON.stringify([humanChange]) })
    expect(await resolveDriftActor(client, { accountId: 'acc-1' })).toBeUndefined()
  })

  it('never throws — returns undefined when the request throws', async () => {
    const { client } = mockClient({ throwErr: true })
    expect(await resolveDriftActor(client, { accountId: 'acc-1' })).toBeUndefined()
  })

  it('returns undefined on a malformed Activities body', async () => {
    const { client } = mockClient({ body: 'not-json' })
    expect(await resolveDriftActor(client, { accountId: 'acc-1' })).toBeUndefined()
  })

  it('makes no request and returns undefined when neither source is given', async () => {
    const { client, calls } = mockClient()
    expect(await resolveDriftActor(client, {})).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', async () => {
    const { client } = mockClient({ body: JSON.stringify({ Activities: [humanChange] }) })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'db-sa@App.address' },
      { field: 'db-sa@App.userName' },
    ]
    await attachDriftActor(client, diffs, { accountId: 'acc-1', excludeActorLogins: [] })
    expect(diffs[0].actor?.name).toBe('alice')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no actor is resolvable', async () => {
    const { client } = mockClient({ body: JSON.stringify([]) })
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'db-sa@App.address' }]
    await attachDriftActor(client, diffs, { accountId: 'acc-1' })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('leaves member diffs unattributed (no creator metadata)', async () => {
    const { client, calls } = mockClient()
    const member = { memberName: 'app-team', permissions: {} } as CyberArkResource
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'app-team@App.permissions' }]
    await attachDriftActor(client, diffs, { resource: member, excludeActorLogins: [] })
    expect(diffs[0].actor).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('is a no-op (no request) when there are no diffs', async () => {
    const { client, calls } = mockClient({ body: JSON.stringify({ Activities: [humanChange] }) })
    await attachDriftActor(client, [], { accountId: 'acc-1' })
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
