import {
  pickActorFromResource,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type ModifiedResource,
  type DriftActor,
} from '../elasticAudit'

// --- Fixtures -----------------------------------------------------------------

/** A rule / list last written by a human, recorded with a bare username. */
const usernameModifier: ModifiedResource = {
  updated_by: 'jdoe',
  updated_at: '2026-07-21T09:00:00Z',
  created_by: 'admin',
  created_at: '2026-07-01T08:00:00Z',
}

/** An SSO deployment records the principal as an email. */
const emailModifier: ModifiedResource = {
  updated_by: 'alice@acme.com',
  updated_at: '2026-07-20T10:00:00Z',
}

/** The connection login our own deploys are recorded under — excluded. */
const VELTRIX_LOGIN = 'veltrix-deployer'
const veltrixModifier: ModifiedResource = {
  updated_by: VELTRIX_LOGIN,
  updated_at: '2026-07-22T08:00:00Z',
}

// --- pickActorFromResource (pure) --------------------------------------------

describe('pickActorFromResource', () => {
  it('maps a bare-username modifier to id (not email) and reads updated_at', () => {
    const actor = pickActorFromResource(usernameModifier, [])
    expect(actor).toEqual({
      source: 'elastic-audit',
      name: 'jdoe',
      id: 'jdoe',
      at: '2026-07-21T09:00:00Z',
    })
  })

  it('maps an email modifier to a fully-populated actor', () => {
    const actor = pickActorFromResource(emailModifier, [])
    expect(actor).toEqual({
      source: 'elastic-audit',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
      at: '2026-07-20T10:00:00Z',
    })
  })

  it('prefers updated_by (the last writer) over created_by', () => {
    const actor = pickActorFromResource(usernameModifier, [])
    expect(actor?.name).toBe('jdoe')
    expect(actor?.at).toBe('2026-07-21T09:00:00Z')
  })

  it('falls back to created_by / created_at when updated_by is absent', () => {
    const actor = pickActorFromResource(
      { created_by: 'admin', created_at: '2026-07-01T08:00:00Z' },
      [],
    )
    expect(actor).toEqual({
      source: 'elastic-audit',
      name: 'admin',
      id: 'admin',
      at: '2026-07-01T08:00:00Z',
    })
  })

  it('returns undefined when the last writer is the excluded Veltrix login', () => {
    expect(pickActorFromResource(veltrixModifier, [VELTRIX_LOGIN])).toBeUndefined()
  })

  it('does NOT fall back to created_by when the excluded login was the last writer', () => {
    // updated_by is us; created_by is a human — but the last write was ours, so
    // there is no manual change to attribute.
    const actor = pickActorFromResource(
      { updated_by: VELTRIX_LOGIN, updated_at: '2026-07-22T08:00:00Z', created_by: 'jdoe' },
      [VELTRIX_LOGIN],
    )
    expect(actor).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    const actor = pickActorFromResource(
      { updated_by: 'Veltrix-Deployer', updated_at: '2026-07-20T10:00:00Z' },
      ['veltrix-deployer'],
    )
    expect(actor).toBeUndefined()
  })

  it('returns undefined when there is no modifier field', () => {
    expect(pickActorFromResource({ updated_at: '2026-07-20T10:00:00Z' }, [])).toBeUndefined()
  })

  it('returns undefined for an empty-string modifier', () => {
    expect(pickActorFromResource({ updated_by: '   ' }, [])).toBeUndefined()
  })

  it('returns undefined for a null or non-object resource', () => {
    expect(pickActorFromResource(null, [])).toBeUndefined()
    expect(pickActorFromResource(undefined, [])).toBeUndefined()
  })

  it('omits `at` when the resource has no timestamp field', () => {
    const actor = pickActorFromResource({ updated_by: 'alice@acme.com' }, [])
    expect(actor).toEqual({
      source: 'elastic-audit',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
    })
  })

  it('still attributes a non-excluded human when a Veltrix login is in the exclude list', () => {
    const actor = pickActorFromResource(emailModifier, [VELTRIX_LOGIN])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })
})

// --- resolveDriftActor (best-effort wrapper) ---------------------------------

describe('resolveDriftActor', () => {
  it('resolves the actor from a present modifier', () => {
    const actor = resolveDriftActor(usernameModifier, { excludeActorLogins: [] })
    expect(actor?.name).toBe('jdoe')
  })

  it('returns undefined for an excluded (Veltrix) modifier', () => {
    expect(resolveDriftActor(veltrixModifier, { excludeActorLogins: [VELTRIX_LOGIN] })).toBeUndefined()
  })

  it('returns undefined (never throws) for a null resource', () => {
    expect(resolveDriftActor(null)).toBeUndefined()
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'rule.name' },
      { field: 'rule.enabled' },
    ]
    attachDriftActor(diffs, emailModifier, { excludeActorLogins: [] })
    expect(diffs[0].actor?.email).toBe('alice@acme.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when the modifier is excluded', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'rule.name' }]
    attachDriftActor(diffs, veltrixModifier, { excludeActorLogins: [VELTRIX_LOGIN] })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('leaves diffs unattributed when the object carries no modifier (ILM / role / space)', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'policy' }]
    // An ILM policy exposes only a WHEN (modified_date/updated_at) and no WHO —
    // there is no user to attribute, so it stays unattributed.
    attachDriftActor(diffs, { updated_at: '2026-07-20T10:00:00Z' }, { excludeActorLogins: [] })
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
  it('returns the connection username when present', () => {
    expect(veltrixActorLogins({ username: VELTRIX_LOGIN })).toEqual([VELTRIX_LOGIN])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
