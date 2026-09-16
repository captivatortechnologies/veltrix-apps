// =============================================================================
// threat-insight — driftDetect, driven against the fake Okta org.
//
// Drift here is somebody downgrading the org's threat posture by hand — block
// turned to audit or none — or adding a zone exemption that carves a hole in it.
// Detection must report both without ever writing.
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

function config(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'ThreatInsight',
    fields: { action: 'block', excludeZones: ['nzoCORP'], ...fields },
  }
}

const IN_SYNC = {
  action: 'block',
  excludeZones: ['nzoCORP'],
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/threats/configuration` } },
}

describe('threat-insight driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [config()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [config()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when nothing was deployed', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [config({ action: '' })] }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching org as in sync', async () => {
    const result = await withFetch([ok(IN_SYNC)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [config()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/threats/configuration')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok({ ...IN_SYNC, action: 'none' })], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [config()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('ignores server-managed fields so they can never read as drift', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, lastUpdated: '2026-09-09T00:00:00.000Z' })], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a downgraded action as critical drift', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, action: 'none' })], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'action')
    expect(diff?.expected).toBe('block')
    expect(diff?.actual).toBe('none')
    expect(diff?.severity).toBe('critical')
  })

  it('reports an action Okta no longer returns as "not set" rather than an empty string', async () => {
    const result = await withFetch([ok({ excludeZones: ['nzoCORP'] })], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'action')
    expect(diff?.actual).toBe('not set')
    expect(diff?.severity).toBe('critical')
  })

  it('does not read a case difference in the action as drift', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, action: 'BLOCK' })], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags an added zone exemption — a hole carved in the threat posture', async () => {
    const result = await withFetch(
      [ok({ ...IN_SYNC, excludeZones: ['nzoCORP', 'nzoANYWHERE'] })],
      async () => driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'excludeZones')
    expect(diff?.expected).toEqual(['nzoCORP'])
    expect(diff?.actual).toEqual(['nzoANYWHERE', 'nzoCORP'])
    expect(diff?.severity).toBe('warning')
  })

  it('flags a removed zone exemption too', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, excludeZones: [] })], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'excludeZones')
    expect(diff?.actual).toEqual([])
  })

  it('compares zone exemptions order-insensitively', async () => {
    const result = await withFetch(
      [ok({ ...IN_SYNC, excludeZones: ['nzoVPN', 'nzoCORP'] })],
      async () => driftDetect(driftContext({ sections: [config({ excludeZones: ['nzoCORP', 'nzoVPN'] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('treats an org returning no exemptions as an empty list, not a crash', async () => {
    const result = await withFetch([ok({ action: 'block' })], async () =>
      driftDetect(driftContext({ sections: [config({ excludeZones: [] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports both drifts at once when the posture and its exemptions were changed', async () => {
    const result = await withFetch(
      [ok({ action: 'audit', excludeZones: ['nzoANYWHERE'] })],
      async () => driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(2)
  })

  it('reports an unreadable configuration as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [config()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('threat-insight')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('compares only the first configuration — ThreatInsight is an org singleton', async () => {
    await withFetch([ok(IN_SYNC)], async (calls) => {
      const result = await driftDetect(
        driftContext({
          sections: [config(), { ...config({ action: 'none' }), name: 'Second' }],
        }),
      )

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(1)
    })
  })
})
