import {
  pickActorFromResource,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  epochToIso,
  type ZscalerModifiedResource,
  type DriftActor,
} from '../zscalerAudit'

// --- Fixtures -----------------------------------------------------------------

// 1600000000 (epoch SECONDS) === 2020-09-13T12:26:40.000Z.
const AT_ISO = '2020-09-13T12:26:40.000Z'

/** A ZIA object records the modifier as an id/name pair + epoch-second time. */
const ziaEmailModifier: ZscalerModifiedResource = {
  lastModifiedBy: { id: 55, name: 'alice@acme.com' },
  lastModifiedTime: 1600000000,
}

/** A ZIA object whose modifier name is a display name, not an email. */
const ziaNamedModifier: ZscalerModifiedResource = {
  lastModifiedBy: { id: 55, name: 'John Admin' },
  lastModifiedTime: 1600000000,
}

/** A ZPA object records the modifier as a bare admin id + epoch-second string. */
const zpaModifier: ZscalerModifiedResource = {
  modifiedBy: '216196257331370351',
  modifiedTime: '1600000000',
}

/** The OneAPI client id our own deploys are recorded under — excluded. */
const VELTRIX_CLIENT_ID = 'veltrix-oneapi-client-9988'

// --- pickActorFromResource (pure modifier extraction) ------------------------

describe('pickActorFromResource', () => {
  it('maps a ZIA email id/name pair to a fully-populated actor', () => {
    const actor = pickActorFromResource(ziaEmailModifier, [])
    expect(actor).toEqual({
      source: 'zscaler-audit',
      name: 'alice@acme.com',
      email: 'alice@acme.com',
      id: '55',
      at: AT_ISO,
    })
  })

  it('maps a ZIA display-name modifier to name + id (no email)', () => {
    const actor = pickActorFromResource(ziaNamedModifier, [])
    expect(actor).toEqual({
      source: 'zscaler-audit',
      name: 'John Admin',
      id: '55',
      at: AT_ISO,
    })
  })

  it('maps a ZPA bare-id modifier to name + id and reads modifiedTime', () => {
    const actor = pickActorFromResource(zpaModifier, [])
    expect(actor).toEqual({
      source: 'zscaler-audit',
      name: '216196257331370351',
      id: '216196257331370351',
      at: AT_ISO,
    })
  })

  it('falls back to the id when a ZIA pair has no name', () => {
    const actor = pickActorFromResource({ lastModifiedBy: { id: 999 }, lastModifiedTime: 1600000000 }, [])
    expect(actor).toEqual({ source: 'zscaler-audit', name: '999', id: '999', at: AT_ISO })
  })

  it('omits `at` when the resource has no timestamp field', () => {
    const actor = pickActorFromResource({ lastModifiedBy: { id: 55, name: 'alice@acme.com' } }, [])
    expect(actor).toEqual({ source: 'zscaler-audit', name: 'alice@acme.com', email: 'alice@acme.com', id: '55' })
  })

  it('returns undefined when the ZIA modifier is the excluded Veltrix identity (by name)', () => {
    const resource: ZscalerModifiedResource = {
      lastModifiedBy: { id: 7, name: VELTRIX_CLIENT_ID },
      lastModifiedTime: 1600000000,
    }
    expect(pickActorFromResource(resource, [VELTRIX_CLIENT_ID])).toBeUndefined()
  })

  it('returns undefined when the ZPA modifier is the excluded Veltrix id', () => {
    const resource: ZscalerModifiedResource = { modifiedBy: VELTRIX_CLIENT_ID, modifiedTime: '1600000000' }
    expect(pickActorFromResource(resource, [VELTRIX_CLIENT_ID])).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    const resource: ZscalerModifiedResource = {
      lastModifiedBy: { name: 'ADMIN@acme.com' },
      lastModifiedTime: 1600000000,
    }
    expect(pickActorFromResource(resource, ['admin@acme.com'])).toBeUndefined()
  })

  it('still attributes a non-excluded human when a Veltrix id is in the exclude list', () => {
    const actor = pickActorFromResource(ziaEmailModifier, [VELTRIX_CLIENT_ID])
    expect(actor).toBeDefined()
    expect(actor?.email).toBe('alice@acme.com')
  })

  it('returns undefined when there is no modifier field', () => {
    expect(pickActorFromResource({ name: 'some-rule' }, [])).toBeUndefined()
    expect(pickActorFromResource({}, [])).toBeUndefined()
  })

  it('returns undefined for an empty-string modifier', () => {
    expect(pickActorFromResource({ modifiedBy: '   ' }, [])).toBeUndefined()
    expect(pickActorFromResource({ lastModifiedBy: { id: null, name: '  ' } }, [])).toBeUndefined()
  })

  it('returns undefined for a null or non-object resource', () => {
    expect(pickActorFromResource(null, [])).toBeUndefined()
    expect(pickActorFromResource(undefined, [])).toBeUndefined()
    expect(pickActorFromResource('nope', [])).toBeUndefined()
  })
})

// --- epochToIso ---------------------------------------------------------------

describe('epochToIso', () => {
  it('converts epoch SECONDS (number) to ISO', () => {
    expect(epochToIso(1600000000)).toBe(AT_ISO)
  })

  it('converts an epoch-seconds numeric STRING to ISO', () => {
    expect(epochToIso('1600000000')).toBe(AT_ISO)
  })

  it('passes a millisecond-range value through unscaled', () => {
    expect(epochToIso(1600000000000)).toBe(AT_ISO)
  })

  it('returns undefined for zero, null, undefined, or non-numeric input', () => {
    expect(epochToIso(0)).toBeUndefined()
    expect(epochToIso(null)).toBeUndefined()
    expect(epochToIso(undefined)).toBeUndefined()
    expect(epochToIso('not-a-number')).toBeUndefined()
  })
})

// --- resolveDriftActor (best-effort wrapper) ---------------------------------

describe('resolveDriftActor', () => {
  it('resolves the actor from a present modifier', () => {
    const actor = resolveDriftActor(ziaEmailModifier, { excludeActorLogins: [] })
    expect(actor?.name).toBe('alice@acme.com')
  })

  it('returns undefined for an excluded (Veltrix) modifier', () => {
    const resource: ZscalerModifiedResource = { modifiedBy: VELTRIX_CLIENT_ID, modifiedTime: '1600000000' }
    expect(resolveDriftActor(resource, { excludeActorLogins: [VELTRIX_CLIENT_ID] })).toBeUndefined()
  })

  it('returns undefined (never throws) for a null resource', () => {
    expect(resolveDriftActor(null)).toBeUndefined()
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches one shared actor reference to every diff of the object', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'rule.order' },
      { field: 'rule.state' },
    ]
    attachDriftActor(diffs, ziaEmailModifier, { excludeActorLogins: [] })
    expect(diffs[0].actor?.email).toBe('alice@acme.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when the modifier is excluded', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'segment.enabled' }]
    const resource: ZscalerModifiedResource = { modifiedBy: VELTRIX_CLIENT_ID, modifiedTime: '1600000000' }
    attachDriftActor(diffs, resource, { excludeActorLogins: [VELTRIX_CLIENT_ID] })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('leaves diffs unattributed when the resource has no modifier', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'rule.state' }]
    attachDriftActor(diffs, {}, { excludeActorLogins: [] })
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op when there are no diffs', () => {
    // Must not throw with an empty slice.
    attachDriftActor([], ziaEmailModifier, { excludeActorLogins: [] })
    expect(true).toBe(true)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection username (the OneAPI client id) when present', () => {
    expect(veltrixActorLogins({ username: VELTRIX_CLIENT_ID })).toEqual([VELTRIX_CLIENT_ID])
  })

  it('returns an empty list for a missing or blank username', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
