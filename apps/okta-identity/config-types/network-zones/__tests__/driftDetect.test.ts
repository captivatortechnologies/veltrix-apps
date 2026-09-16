// =============================================================================
// network-zones — driftDetect, driven against the fake Okta org.
//
// Drift on a zone is somebody moving a network boundary by hand: a CIDR widened,
// a zone deactivated, a zone deleted out from under the policies that reference
// it. These tests pin each drift shape, prove detection never writes, and cover
// the System Log attribution — including that Veltrix's own deploy identity is
// never blamed for its own change.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  ADMIN_LOGIN,
  API_BASE,
  apiError,
  driftContext,
  leaksToken,
  logEvent,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const DECLARED_GATEWAYS = [{ type: 'CIDR', value: '203.0.113.0/24' }]

function zone(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Corp egress',
    fields: {
      name: 'Corp egress',
      type: 'IP',
      status: 'ACTIVE',
      configJson: JSON.stringify({ gateways: DECLARED_GATEWAYS }),
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'nzoLIVE',
  name: 'Corp egress',
  type: 'IP',
  status: 'ACTIVE',
  system: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/zones/nzoLIVE` } },
  gateways: DECLARED_GATEWAYS,
}

describe('network-zones driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [zone()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [zone()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching zone as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [zone()] }))
      // In sync means no diffs, so attribution is never even queried.
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/zones')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }]), ok([])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [zone()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('ignores server-managed fields so they can never read as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-09T00:00:00.000Z', system: true, _embedded: { x: 1 } }])],
      async () => driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted zone as critical drift', async () => {
    const result = await withFetch([ok([]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Corp egress')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a widened CIDR as critical drift — the boundary moved', async () => {
    const widened = [{ type: 'CIDR', value: '0.0.0.0/0' }]
    const result = await withFetch([ok([{ ...IN_SYNC, gateways: widened }]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Corp egress.gateways')
    expect(diff?.severity).toBe('critical')
    expect(diff?.expected).toEqual(DECLARED_GATEWAYS)
    expect(diff?.actual).toEqual(widened)
  })

  it('flags a definition key the live zone no longer carries', async () => {
    const live = { ...IN_SYNC }
    delete (live as { gateways?: unknown }).gateways
    const result = await withFetch([ok([live]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp egress.gateways')
    expect(diff?.actual).toBe('not set')
  })

  it('does not read key order or nesting order as drift', async () => {
    const reordered = [{ value: '203.0.113.0/24', type: 'CIDR' }]
    const result = await withFetch([ok([{ ...IN_SYNC, gateways: reordered }])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never compares a definition key the deployed config does not declare', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, proxies: [{ type: 'CIDR', value: '10.0.0.0/8' }] }])],
      async () => driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a zone whose kind was changed as critical drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, type: 'DYNAMIC' }]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp egress.type')
    expect(diff?.expected).toBe('IP')
    expect(diff?.actual).toBe('DYNAMIC')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a zone deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp egress.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('reports an unreadable zone list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Corp egress')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a malformed stored definition without throwing', async () => {
    const result = await withFetch([ok([IN_SYNC]), ok([])], async () =>
      driftDetect(driftContext({ sections: [zone({ configJson: '{not json' })] })),
    )

    // The definition cannot be compared, but identity and status still are.
    expect(result.hasDrift).toBe(false)
  })

  it('attributes a drift to the admin who moved the boundary', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'zone.update' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [zone()] }))

        const log = calls.find((c) => c.path === '/logs')
        expect(log).toBeDefined()
        // The reliable filter is by live object id, not a free-text name search.
        expect(log?.query.filter).toBe('target.id eq "nzoLIVE"')
        expect(log?.query.sortOrder).toBe('DESCENDING')
        return res
      },
    )

    const actor = (result.diffs[0] as { actor?: { email?: string; eventType?: string } }).actor
    expect(actor?.email).toBe('nina@example.com')
    expect(actor?.eventType).toBe('zone.update')
  })

  it('attaches the same actor to every diff one zone produced, with a single log query', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE', gateways: [{ type: 'CIDR', value: '0.0.0.0/0' }] }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'zone.update' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [zone()] }))
        expect(calls.filter((c) => c.path === '/logs')).toHaveLength(1)
        return res
      },
    )

    expect(result.diffs).toHaveLength(2)
    for (const diff of result.diffs) {
      expect((diff as { actor?: { email?: string } }).actor?.email).toBe('nina@example.com')
    }
  })

  it('falls back to a name search when the zone is gone and has no live id', async () => {
    await withFetch(
      [ok([]), ok([logEvent({ login: 'nina@example.com', eventType: 'zone.delete' })])],
      async (calls) => {
        await driftDetect(driftContext({ sections: [zone()] }))

        const log = calls.find((c) => c.path === '/logs')
        expect(log?.query.q).toBe('Corp egress')
        expect(log?.query.filter).toBeUndefined()
      },
    )
  })

  it('does not blame Veltrix\'s own deploy identity for the drift', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: ADMIN_LOGIN, eventType: 'zone.update' })]),
      ],
      async () => driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('ignores a non-human actor in the System Log', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: 'svc@example.com', type: 'SystemPrincipal', eventType: 'zone.update' })]),
      ],
      async () => driftDetect(driftContext({ sections: [zone()] })),
    )

    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('still reports the drift when attribution itself fails', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, status: 'INACTIVE' }]), apiError('System log unavailable', 500)],
      async () => driftDetect(driftContext({ sections: [zone()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('skips a section with no name or no type rather than flagging it as drift', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Half done', fields: { name: 'Corp egress' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('never inspects a zone the deployed config does not declare', async () => {
    await withFetch([ok([IN_SYNC, { id: 'nzoOTHER', name: 'Untouched' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [zone()] }))
      expect(result.hasDrift).toBe(false)
      expect(calls.some((c) => c.path.includes('nzoOTHER'))).toBe(false)
    })
  })
})
