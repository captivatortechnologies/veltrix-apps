// =============================================================================
// behavior-rules — driftDetect, driven against the fake Okta org.
//
// Drift here is the risk signal being turned down by hand: a velocity threshold
// raised past anything a human could trip, a rule deactivated, a whole behavior
// deleted. Every settings key the canvas declares is compared; keys Okta defaults
// on its own are not. Detection must never write, and an unreadable org is a
// reported diff rather than a crash.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function behavior(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Impossible travel',
    fields: {
      type: 'VELOCITY',
      name: 'Impossible travel',
      status: 'ACTIVE',
      settingsJson: '{"velocityKph":805}',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'beh-1',
  name: 'Impossible travel',
  type: 'VELOCITY',
  status: 'ACTIVE',
  settings: { velocityKph: 805 },
}

describe('behavior-rules driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [behavior()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [behavior()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean behavior as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [behavior()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/behaviors')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [behavior()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted behavior as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [behavior()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Impossible travel')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a threshold raised out of band — the signal-turned-down shape', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { velocityKph: 99999 } }])],
      async () => driftDetect(driftContext({ sections: [behavior()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Impossible travel.settings.velocityKph')
    expect(diff?.expected).toBe(805)
    expect(diff?.actual).toBe(99999)
    expect(diff?.severity).toBe('critical')
  })

  it('flags a declared setting the live behavior no longer carries', async () => {
    const result = await withFetch(
      [ok([{ id: 'beh-1', name: 'Impossible travel', type: 'VELOCITY', status: 'ACTIVE' }])],
      async () => driftDetect(driftContext({ sections: [behavior()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Impossible travel.settings.velocityKph')
    expect(diff?.actual).toBe('not set')
  })

  it('does not compare settings keys the canvas never declared', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { velocityKph: 805, maxEventsUsedForEvaluation: 20 } }])],
      async () => driftDetect(driftContext({ sections: [behavior()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('ignores key order inside a declared setting', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { history: { b: 2, a: 1 } } }])],
      async () =>
        driftDetect(
          driftContext({ sections: [behavior({ settingsJson: '{"history":{"a":1,"b":2}}' })] }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a changed behavior kind as critical drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, type: 'ANOMALOUS_IP' }])], async () =>
      driftDetect(driftContext({ sections: [behavior()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Impossible travel.type')
    expect(diff?.expected).toBe('VELOCITY')
    expect(diff?.actual).toBe('ANOMALOUS_IP')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a behavior switched off out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [behavior()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Impossible travel.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not fabricate status drift when the live object reports no status', async () => {
    const result = await withFetch(
      [ok([{ id: 'beh-1', name: 'Impossible travel', type: 'VELOCITY', settings: { velocityKph: 805 } }])],
      async () => driftDetect(driftContext({ sections: [behavior()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [behavior()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Impossible travel')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining behaviors after one read fails', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, status: 'INACTIVE' }])],
      async () =>
        driftDetect(driftContext({ sections: [behavior({ name: 'New device' }), behavior()] })),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0].field).toBe('New device')
    expect(result.diffs[1].field).toBe('Impossible travel.status')
  })

  it('ignores a section with no name or type', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
