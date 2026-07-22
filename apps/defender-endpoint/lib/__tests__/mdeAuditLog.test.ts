import {
  pickActorFromEvents,
  indicatorAuditEvents,
  ruleAuditEvents,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type MdeAuditEvent,
  type IndicatorAudit,
  type RuleAudit,
  type DriftActor,
} from '../mdeAuditLog'

// --- Fixtures -----------------------------------------------------------------

/** A human admin's update stamp (a change). */
const humanUpdate: MdeAuditEvent = {
  actor: 'alice@contoso.com',
  at: '2026-07-21T10:00:00.000Z',
  eventType: 'updated',
  human: true,
  change: true,
}

/** A human's create stamp (the fallback when there is no human update). */
const humanCreate: MdeAuditEvent = {
  actor: 'bob@contoso.com',
  at: '2026-07-19T08:00:00.000Z',
  eventType: 'created',
  human: true,
  change: false,
}

/** A Veltrix app-only stamp (app id) — never attributable. */
const veltrixStamp: MdeAuditEvent = {
  actor: 'veltrix-app-id',
  at: '2026-07-22T09:00:00.000Z',
  eventType: 'updated',
  human: false,
  change: true,
}

// --- pickActorFromEvents (pure) ----------------------------------------------

describe('pickActorFromEvents', () => {
  it('returns the human actor for an update (change) event', () => {
    expect(pickActorFromEvents([humanUpdate], [])).toEqual({
      source: 'defender-audit',
      name: 'alice@contoso.com',
      email: 'alice@contoso.com',
      at: '2026-07-21T10:00:00.000Z',
      eventType: 'updated',
    })
  })

  it('returns undefined for an empty event list', () => {
    expect(pickActorFromEvents([], [])).toBeUndefined()
  })

  it('ignores a non-human (application) stamp', () => {
    expect(pickActorFromEvents([veltrixStamp], [])).toBeUndefined()
  })

  it('excludes the Veltrix identity even when it is marked human', () => {
    const humanish: MdeAuditEvent = { ...veltrixStamp, human: true }
    expect(pickActorFromEvents([humanish], ['veltrix-app-id'])).toBeUndefined()
  })

  it('excludes the Veltrix identity case-insensitively', () => {
    const humanish: MdeAuditEvent = { ...veltrixStamp, human: true }
    expect(pickActorFromEvents([humanish], ['VELTRIX-APP-ID'])).toBeUndefined()
  })

  it('prefers the change (update) event over a more recent non-change event', () => {
    const laterRead: MdeAuditEvent = { ...humanCreate, at: '2026-07-22T12:00:00.000Z', change: false }
    const actor = pickActorFromEvents([laterRead, humanUpdate], [])
    expect(actor?.eventType).toBe('updated')
    expect(actor?.at).toBe('2026-07-21T10:00:00.000Z')
  })

  it('falls back to the most recent human event when none is a change', () => {
    const older: MdeAuditEvent = { ...humanCreate, at: '2026-07-18T00:00:00.000Z' }
    const actor = pickActorFromEvents([older, humanCreate], [])
    expect(actor?.at).toBe('2026-07-19T08:00:00.000Z')
    expect(actor?.eventType).toBe('created')
  })

  it('sets name only (no email) when the identity is not a UPN', () => {
    const appName: MdeAuditEvent = { actor: 'Some Service', at: '2026-07-20T00:00:00.000Z', eventType: 'updated', human: true, change: true }
    const actor = pickActorFromEvents([appName], [])
    expect(actor?.name).toBe('Some Service')
    expect(actor?.email).toBeUndefined()
  })

  it('attributes the human change when a more-recent Veltrix update is excluded', () => {
    const actor = pickActorFromEvents([veltrixStamp, humanUpdate], ['veltrix-app-id'])
    expect(actor?.email).toBe('alice@contoso.com')
  })
})

// --- indicatorAuditEvents (pure) ---------------------------------------------

describe('indicatorAuditEvents', () => {
  it('derives a create + update event from a fully-stamped indicator', () => {
    const ind: IndicatorAudit = {
      createdBy: 'bob@contoso.com',
      sourceType: 'User',
      creationTimeDateTimeUtc: '2026-07-19T08:00:00.000Z',
      lastUpdatedBy: 'alice@contoso.com',
      lastUpdateTime: '2026-07-21T10:00:00.000Z',
    }
    const events = indicatorAuditEvents(ind)
    expect(events).toHaveLength(2)
    expect(events[0].eventType).toBe('created')
    expect(events[0].human).toBe(true)
    expect(events[1].eventType).toBe('updated')
    expect(events[1].change).toBe(true)
    expect(events[1].actor).toBe('alice@contoso.com')
  })

  it('marks a User-sourced create as human and an AadApp-sourced create as non-human', () => {
    const user: IndicatorAudit = { createdBy: 'x@contoso.com', sourceType: 'User', creationTimeDateTimeUtc: '2026-07-19T08:00:00.000Z' }
    const app: IndicatorAudit = { createdBy: 'veltrix-app-id', sourceType: 'AadApp', creationTimeDateTimeUtc: '2026-07-19T08:00:00.000Z' }
    expect(indicatorAuditEvents(user)[0].human).toBe(true)
    expect(indicatorAuditEvents(app)[0].human).toBe(false)
  })

  it('drops the update stamp when lastUpdatedBy is null (creation-only stamp)', () => {
    // Mirrors the API: a never-updated indicator has lastUpdateTime set but lastUpdatedBy null.
    const ind: IndicatorAudit = {
      createdBy: 'bob@contoso.com',
      sourceType: 'User',
      creationTimeDateTimeUtc: '2026-07-19T08:00:00.000Z',
      lastUpdatedBy: null,
      lastUpdateTime: '2026-07-19T08:00:00.000Z',
    }
    const events = indicatorAuditEvents(ind)
    // Update event exists (has a time) but has no actor, so it is non-human and filtered.
    const actor = resolveDriftActor(events, [])
    expect(actor?.eventType).toBe('created')
    expect(actor?.email).toBe('bob@contoso.com')
  })

  it('falls back to createdBySource when createdBy is absent', () => {
    const ind: IndicatorAudit = { createdBySource: 'carol@contoso.com', sourceType: 'User', creationTimeDateTimeUtc: '2026-07-19T08:00:00.000Z' }
    expect(indicatorAuditEvents(ind)[0].actor).toBe('carol@contoso.com')
  })

  it('returns no events for an indicator with no stamps', () => {
    expect(indicatorAuditEvents({})).toHaveLength(0)
  })

  it('attributes a human portal edit over a Veltrix (AadApp) creation', () => {
    // The primary drift scenario: Veltrix created the indicator, a human edited it.
    const ind: IndicatorAudit = {
      createdBy: 'veltrix-app-id',
      sourceType: 'AadApp',
      creationTimeDateTimeUtc: '2026-07-18T00:00:00.000Z',
      lastUpdatedBy: 'alice@contoso.com',
      lastUpdateTime: '2026-07-21T10:00:00.000Z',
    }
    const actor = resolveDriftActor(indicatorAuditEvents(ind), veltrixActorLogins({ username: 'veltrix-app-id' }))
    expect(actor?.email).toBe('alice@contoso.com')
    expect(actor?.eventType).toBe('updated')
  })
})

// --- ruleAuditEvents (pure) --------------------------------------------------

describe('ruleAuditEvents', () => {
  it('derives a create + update event from a fully-stamped rule', () => {
    const rule: RuleAudit = {
      createdBy: 'bob@contoso.com',
      createdDateTime: '2026-07-19T08:00:00.000Z',
      lastModifiedBy: 'alice@contoso.com',
      lastModifiedDateTime: '2026-07-21T10:00:00.000Z',
    }
    const events = ruleAuditEvents(rule)
    expect(events).toHaveLength(2)
    expect(events[1].eventType).toBe('updated')
    expect(events[1].actor).toBe('alice@contoso.com')
    expect(events[1].human).toBe(true)
  })

  it('treats a non-UPN app modifier as non-human (best-effort, no sourceType flag)', () => {
    const rule: RuleAudit = { lastModifiedBy: 'Veltrix Provisioner', lastModifiedDateTime: '2026-07-21T10:00:00.000Z' }
    expect(ruleAuditEvents(rule)[0].human).toBe(false)
  })

  it('attributes a human modification of a rule', () => {
    const rule: RuleAudit = {
      createdBy: 'veltrix-app-id',
      createdDateTime: '2026-07-18T00:00:00.000Z',
      lastModifiedBy: 'dana@contoso.com',
      lastModifiedDateTime: '2026-07-21T10:00:00.000Z',
    }
    const actor = resolveDriftActor(ruleAuditEvents(rule), veltrixActorLogins({ username: 'veltrix-app-id' }))
    expect(actor?.email).toBe('dana@contoso.com')
  })
})

// --- resolveDriftActor --------------------------------------------------------

describe('resolveDriftActor', () => {
  it('resolves a human actor from derived events', () => {
    expect(resolveDriftActor([humanUpdate], [])?.name).toBe('alice@contoso.com')
  })

  it('returns undefined for an empty event list', () => {
    expect(resolveDriftActor([], [])).toBeUndefined()
  })

  it('returns undefined when every event is a Veltrix/app stamp', () => {
    expect(resolveDriftActor([veltrixStamp], ['veltrix-app-id'])).toBeUndefined()
  })

  it('never throws — tolerates a malformed event list', () => {
    let threw = false
    let result: DriftActor | undefined
    try {
      result = resolveDriftActor(undefined as unknown as MdeAuditEvent[], [])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBeUndefined()
  })
})

// --- attachDriftActor ---------------------------------------------------------

describe('attachDriftActor', () => {
  it('attaches the resolved actor to every diff of the object', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'IpAddress 1.2.3.4.action' },
      { field: 'IpAddress 1.2.3.4.severity' },
    ]
    attachDriftActor(diffs, [humanUpdate], [])
    expect(diffs[0].actor?.name).toBe('alice@contoso.com')
    // One resolve, one shared actor reference across the object's diffs.
    expect(diffs[1].actor).toBe(diffs[0].actor)
  })

  it('leaves diffs unattributed when no human actor is resolvable', () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'x' }]
    attachDriftActor(diffs, [veltrixStamp], ['veltrix-app-id'])
    expect(diffs[0].actor).toBeUndefined()
  })

  it('is a no-op when there are no diffs', () => {
    // Should not throw and should not need any events.
    let threw = false
    try {
      attachDriftActor([], [humanUpdate], [])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

// --- veltrixActorLogins -------------------------------------------------------

describe('veltrixActorLogins', () => {
  it('returns the connection Client ID (appId) when present', () => {
    expect(veltrixActorLogins({ username: 'veltrix-app-id' })).toEqual(['veltrix-app-id'])
  })

  it('returns an empty list for a missing or blank Client ID', () => {
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins({ username: '   ' })).toEqual([])
    expect(veltrixActorLogins({ username: null })).toEqual([])
  })
})
