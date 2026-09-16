// =============================================================================
// features — driftDetect, driven against the fake Okta org.
//
// A feature toggle has exactly one authored field, so drift is binary: the switch
// is where the canvas said, or somebody moved it. Okta's own release `stage`
// metadata changes on its own schedule and must never be reported as drift, or
// every check would cry wolf.
// =============================================================================

import driftDetect from '../driftDetect'
import type { LiveFeature } from '../validate'
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

function feature(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Number challenge',
    fields: {
      name: 'Okta Verify Number Challenge',
      status: 'ENABLED',
      forceDependencies: false,
      ...fields,
    },
  }
}

const IN_SYNC: LiveFeature = {
  id: 'ftLIVE',
  name: 'Okta Verify Number Challenge',
  description: 'Number challenge for Okta Verify push',
  type: 'self-service',
  status: 'ENABLED',
  stage: { state: 'OPEN', value: 'EA' },
}

describe('features driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [feature()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [feature()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching toggle as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [feature()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/features')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection must not toggle a feature', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'DISABLED' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [feature()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a feature switched off out of band as critical drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'DISABLED' }])], async () =>
      driftDetect(driftContext({ sections: [feature()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Okta Verify Number Challenge.status')
    expect(diff?.expected).toBe('ENABLED')
    expect(diff?.actual).toBe('DISABLED')
    // The toggle IS the config — a moved switch is never a mere warning here.
    expect(diff?.severity).toBe('critical')
  })

  it('flags a feature switched on where the canvas says disabled', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [feature({ status: 'DISABLED' })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Okta Verify Number Challenge.status')
    expect(diff?.expected).toBe('DISABLED')
    expect(diff?.actual).toBe('ENABLED')
  })

  it('reports a feature with no live status as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: undefined }])], async () =>
      driftDetect(driftContext({ sections: [feature()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Okta Verify Number Challenge.status')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a feature that vanished from the org as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [feature()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Okta Verify Number Challenge')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('matches the feature name case-insensitively', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [feature({ name: 'okta verify number challenge' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never reports Okta-managed release stage metadata as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, stage: { state: 'CLOSED', value: 'BETA' }, description: 'Reworded by Okta' }])],
      async () => driftDetect(driftContext({ sections: [feature()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable feature list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [feature()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].actual).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining features after one becomes unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, name: 'Second feature' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [feature(), { name: 'Second', fields: { ...feature({ name: 'Second feature' }).fields } }],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Okta Verify Number Challenge')
  })

  it('makes no System Log call — this config type attaches no drift actor', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'DISABLED' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [feature()] }))

      expect(result.hasDrift).toBe(true)
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
      expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
    })
  })
})
