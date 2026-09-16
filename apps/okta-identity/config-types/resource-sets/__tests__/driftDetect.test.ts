// =============================================================================
// resource-sets — driftDetect, driven against the fake Okta org.
//
// A resource quietly added to a live set widens every admin grant bound to it,
// so membership drift is CRITICAL in both directions. These tests pin the
// comparison (order-insensitive, ORN or REST-URL form), prove an unreadable set
// is reported rather than skipped, and prove detection never writes.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  API_BASE,
  apiError,
  driftContext,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ORN_GROUPS = 'orn:okta:directory:00o1:groups'
const ORN_USERS = 'orn:okta:directory:00o1:users'
const ORN_APPS = 'orn:okta:idp:00o1:apps'

function resourceSet(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Helpdesk scope',
    fields: {
      label: 'Helpdesk scope',
      description: 'What Tier 1 may touch',
      resources: [ORN_GROUPS, ORN_USERS],
      ...fields,
    },
  }
}

const LIVE_SET = { id: 'iamLIVE', label: 'Helpdesk scope', description: 'What Tier 1 may touch' }

function setsList(sets: unknown[]) {
  return ok({ 'resource-sets': sets })
}

function membership(id: string, orn: string) {
  return { id, orn, _links: { self: { href: `${API_BASE}/iam/resource-sets/iamLIVE/resources/${id}` } } }
}

function membershipsList(items: unknown[]) {
  return ok({ resources: items })
}

const IN_SYNC_MEMBERSHIPS = membershipsList([
  membership('mem-1', ORN_GROUPS),
  membership('mem-2', ORN_USERS),
])

describe('resource-sets driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [resourceSet()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [resourceSet()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching set as in sync', async () => {
    const result = await withFetch([setsList([LIVE_SET]), IN_SYNC_MEMBERSHIPS], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [resourceSet()] }))
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe('/iam/resource-sets')
      expect(calls[1].path).toBe('/iam/resource-sets/iamLIVE/resources')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch(
      [setsList([LIVE_SET]), membershipsList([membership('mem-9', ORN_APPS)])],
      async (calls) => {
        const result = await driftDetect(driftContext({ sections: [resourceSet()] }))
        expect(result.hasDrift).toBe(true)
        expect(writeCalls(calls)).toHaveLength(0)
      },
    )
  })

  it('flags a deleted resource set as critical drift', async () => {
    const result = await withFetch([setsList([])], async () =>
      driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Helpdesk scope')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags an added resource as critical drift — this is scope widening', async () => {
    const result = await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([
          membership('mem-1', ORN_GROUPS),
          membership('mem-2', ORN_USERS),
          membership('mem-3', ORN_APPS),
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Helpdesk scope.resources')
    expect(diff?.severity).toBe('critical')
    expect(diff?.expected).toEqual([ORN_GROUPS, ORN_USERS])
    expect(diff?.actual).toEqual([ORN_GROUPS, ORN_USERS, ORN_APPS])
  })

  it('flags a removed resource as critical drift too', async () => {
    const result = await withFetch(
      [setsList([LIVE_SET]), membershipsList([membership('mem-1', ORN_GROUPS)])],
      async () => driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk scope.resources')
    expect(diff?.actual).toEqual([ORN_GROUPS])
  })

  it('compares membership order-insensitively', async () => {
    const result = await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-2', ORN_USERS), membership('mem-1', ORN_GROUPS)]),
      ],
      async () => driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('accepts a resource declared in REST-URL form against its live membership', async () => {
    const href = `${API_BASE}/groups/00g1`
    const result = await withFetch(
      [setsList([LIVE_SET]), membershipsList([{ id: 'mem-1', _links: { self: { href } } }])],
      async () => driftDetect(driftContext({ sections: [resourceSet({ resources: [href] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a rewritten description as a warning', async () => {
    const result = await withFetch(
      [setsList([{ ...LIVE_SET, description: 'Now covers everything' }]), IN_SYNC_MEMBERSHIPS],
      async () => driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk scope.description')
    expect(diff?.expected).toBe('What Tier 1 may touch')
    expect(diff?.actual).toBe('Now covers everything')
    expect(diff?.severity).toBe('warning')
  })

  it('renders a cleared description as "not set" rather than an empty string', async () => {
    const result = await withFetch(
      [setsList([{ id: 'iamLIVE', label: 'Helpdesk scope' }]), IN_SYNC_MEMBERSHIPS],
      async () => driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk scope.description')
    expect(diff?.actual).toBe('not set')
  })

  it('never reads the label as drift — it is the identity the match is made on', async () => {
    const result = await withFetch([setsList([LIVE_SET]), IN_SYNC_MEMBERSHIPS], async () =>
      driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.label'))).toHaveLength(0)
  })

  it('reports an unreadable set list as one critical diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [resourceSet()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('resource-sets')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable membership as critical drift on that set alone', async () => {
    const result = await withFetch(
      [
        setsList([LIVE_SET, { id: 'iamTWO', label: 'Tier 2 scope', description: 'What Tier 1 may touch' }]),
        apiError('Insufficient permissions', 403),
        IN_SYNC_MEMBERSHIPS,
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              resourceSet(),
              { ...resourceSet({ label: 'Tier 2 scope' }), name: 'Tier 2 scope' },
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const broken = result.diffs.find((d) => d.field === 'Helpdesk scope')
    expect(String(broken?.actual)).toMatch(/unreachable/)
    expect(broken?.severity).toBe('critical')
    // The second set was still compared — one unreadable object does not abort.
    expect(result.diffs).toHaveLength(1)
  })

  it('ignores a section with no declared resources rather than flagging it as drift', async () => {
    const result = await withFetch([setsList([])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [resourceSet({ resources: [] })] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(false)
  })

  it('never inspects a resource set the deployed config does not declare', async () => {
    await withFetch(
      [setsList([LIVE_SET, { id: 'iamOTHER', label: 'Untouched' }]), IN_SYNC_MEMBERSHIPS],
      async (calls) => {
        await driftDetect(driftContext({ sections: [resourceSet()] }))
        expect(calls.some((c) => c.path.includes('iamOTHER'))).toBe(false)
      },
    )
  })
})
