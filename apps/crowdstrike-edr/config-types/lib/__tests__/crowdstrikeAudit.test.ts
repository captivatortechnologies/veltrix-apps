import {
  pickActorFromResource,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type ModifiedResource,
  type DriftActor,
} from '../crowdstrikeAudit'

// --- Fixtures -----------------------------------------------------------------

/** A prevention policy / host group carries an email modifier + modified_timestamp. */
const emailModifier: ModifiedResource = {
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-07-20T10:00:00Z',
}

/** A custom IOC carries a uuid modifier + modified_on (no modified_timestamp). */
const uuidModifier: ModifiedResource = {
  modified_by: 'a1b2c3d4-1111-2222-3333-444455556666',
  modified_on: '2026-07-21T09:00:00Z',
}

/** The Falcon API client id our own deploys are recorded under — excluded. */
const VELTRIX_CLIENT_ID = '99998888-7777-6666-5555-444433332222'
const veltrixModifier: ModifiedResource = {
  modified_by: VELTRIX_CLIENT_ID,
  modified_timestamp: '2026-07-22T08:00:00Z',
}

// --- pickActorFromResource (pure) --------------------------------------------

describe('pickActorFromResource', () => {
  it('maps an email modifier to a fully-populated actor', () => {
    const actor = pickActorFromResource(emailModifier, [])
    expect(actor).toEqual({
      source: 'crowdstrike-audit',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00Z',
    })
  })

  it('maps a uuid modifier to id (not email) and reads modified_on', () => {
    const actor = pickActorFromResource(uuidModifier, [])
    expect(actor).toEqual({
      source: 'crowdstrike-audit',
      name: 'a1b2c3d4-1111-2222-3333-444455556666',
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      at: '2026-07-21T09:00:00Z',
    })
  })

  it('returns undefined when the modifier is the excluded Veltrix client id', () => {
    expect(pickActorFromResource(veltrixModifier, [VELTRIX_CLIENT_ID])).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    const actor = pickActorFromResource(
      { modified_by: 'ADMIN@acme.com', modified_timestamp: '2026-07-20T10:00:00Z' },
      ['admin@acme.com'],
    )
    expect(actor).toBeUndefined()
  })

  it('returns undefined when there is no modified_by field', () => {
    expect(pickActorFromResource({ modified_timestamp: '2026-07-20T10:00:00Z' }, [])).toBeUndefined()
  })

  it('returns undefined for an empty-string modifier', () => {
    expect(pickActorFromResource({ modified_by: '   ' }, [])).toBeUndefined()
  })

  it('returns undefined for a null or non-object resource', () => {
    expect(pickActorFromResource(null, [])).toBeUndefined()
    expect(pickActorFromResource(undefined, [])).toBeUndefined()
  })

  it('omits `at` when the resource has no timestamp field', () => {
    const actor = pickActorFromResource({ modified_by: 'alice@acme.com' }, [])
    expect(actor).toEqual({
      source: 'crowdstrike-audit',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
    })
  })

  it('still attributes a non-excluded human when a Veltrix id is in the exclude list', () => {
    const actor = pickActorFromResource(emailModifier, [VELTRIX_CLIENT_ID])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })
})

// --- resolveDriftActor (best-effort wrapper) ---------------------------------

describe('resolveDriftActor', () => {
  it('resolves the actor from a present modifier', () => {
    const actor = resolveDriftActor(emailModifier, { excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@acme.com')
  })

  it('returns undefined for an excluded (Veltrix) modifier', () => {
    expect(resolveDriftActor(veltrixModifier, { excludeActorLogins: [VELTRIX_CLIENT_ID] })).toBeUndefined()
  })

  it('returns undefined (never throws) for a null resource', () => {
    expect(resolveDriftActor(null)).toBeUndefined()
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'policy.enabled' },
      { field: 'policy.hostGroups' },
    ]
    attachDriftActor(diffs, emailModifier, { excludeActorLogins: [] })
    expect(diffs[0].actor?.email).toBe('alice@acme.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when the modifier is excluded', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'policy.enabled' }]
    attachDriftActor(diffs, veltrixModifier, { excludeActorLogins: [VELTRIX_CLIENT_ID] })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('leaves diffs unattributed when the resource has no modifier', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'policy.enabled' }]
    attachDriftActor(diffs, {}, { excludeActorLogins: [] })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op when there are no diffs', () => {
    // Must not throw with an empty slice.
    attachDriftActor([], emailModifier, { excludeActorLogins: [] })
    expect(true).toBe(true)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username (the Falcon API client id) when present', () => {
    expect(veltrixActorLogins({ username: VELTRIX_CLIENT_ID })).toEqual([VELTRIX_CLIENT_ID])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
