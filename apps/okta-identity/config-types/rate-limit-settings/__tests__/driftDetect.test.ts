// =============================================================================
// rate-limit-settings — driftDetect, driven against the fake Okta org.
//
// Drift here is somebody loosening the org's throttling out of band: per-client
// mode flipped from ENFORCE to DISABLE (credential stuffing stops being slowed
// down), an override quietly added, admin notifications switched off so nobody
// hears about the next flood. Unlike the collection types, one unreadable
// singleton aborts the whole comparison — that is asserted, not assumed.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ADMIN_PATH = '/rate-limit-settings/admin-notifications'
const PER_CLIENT_PATH = '/rate-limit-settings/per-client'
const THRESHOLD_PATH = '/rate-limit-settings/warning-threshold'

function limits(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Org rate limits',
    fields: {
      adminNotificationsEnabled: true,
      perClientDefaultMode: 'ENFORCE',
      perClientLoginPageMode: 'INHERIT',
      perClientOAuth2AuthorizeMode: 'INHERIT',
      perClientOIEAppIntentMode: 'INHERIT',
      ...fields,
    },
  }
}

const LIVE_ADMIN = { notificationsEnabled: true }
const LIVE_PER_CLIENT = { defaultMode: 'ENFORCE', useCaseModeOverrides: {} }

describe('rate-limit-settings driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [limits()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [limits()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when the deployed config is empty', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [] }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads both singletons and reports a matching org as in sync', async () => {
    const result = await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [limits()] }))

      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(ADMIN_PATH)
      expect(calls[1].path).toBe(PER_CLIENT_PATH)
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok({ notificationsEnabled: false }), ok(LIVE_PER_CLIENT)], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [limits()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags admin notifications switched off out of band', async () => {
    const result = await withFetch(
      [ok({ notificationsEnabled: false }), ok(LIVE_PER_CLIENT)],
      async () => driftDetect(driftContext({ sections: [limits()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'adminNotificationsEnabled')
    expect(diff?.expected).toBe(true)
    expect(diff?.actual).toBe(false)
    expect(diff?.severity).toBe('warning')
  })

  it('flags per-client enforcement switched to DISABLE as critical drift', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok({ defaultMode: 'DISABLE', useCaseModeOverrides: {} })],
      async () => driftDetect(driftContext({ sections: [limits()] })),
    )

    // Losing per-client enforcement removes a live brute-force defence.
    const diff = result.diffs.find((d) => d.field === 'perClientDefaultMode')
    expect(diff?.expected).toBe('ENFORCE')
    expect(diff?.actual).toBe('DISABLE')
    expect(diff?.severity).toBe('critical')
  })

  it('reports a per-client mode the org never returned as "not set"', async () => {
    const result = await withFetch([ok(LIVE_ADMIN), ok({})], async () =>
      driftDetect(driftContext({ sections: [limits()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'perClientDefaultMode')
    expect(diff?.actual).toBe('not set')
  })

  it('flags an override somebody added where the canvas declares INHERIT', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok({ defaultMode: 'ENFORCE', useCaseModeOverrides: { LOGIN_PAGE: 'DISABLE' } })],
      async () => driftDetect(driftContext({ sections: [limits()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'perClientLoginPageMode')
    expect(diff?.expected).toBe('inherit (no override)')
    expect(diff?.actual).toBe('DISABLE')
    expect(diff?.severity).toBe('warning')
  })

  it('flags a declared override that is missing from the live org', async () => {
    const result = await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)], async () =>
      driftDetect(driftContext({ sections: [limits({ perClientOAuth2AuthorizeMode: 'ENFORCE' })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'perClientOAuth2AuthorizeMode')
    expect(diff?.expected).toBe('ENFORCE')
    expect(diff?.actual).toBe('inherit (no override)')
  })

  it('treats a blank live override as inherit rather than as a changed value', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok({ defaultMode: 'ENFORCE', useCaseModeOverrides: { LOGIN_PAGE: '  ' } })],
      async () => driftDetect(driftContext({ sections: [limits()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('does not read the warning threshold at all when the canvas declares none', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [limits()] }))

      expect(result.hasDrift).toBe(false)
      expect(calls.some((c) => c.path === THRESHOLD_PATH)).toBe(false)
    })
  })

  it('flags a changed warning threshold when the canvas declares one', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({ warningThreshold: 45 })],
      async (calls) => {
        const res = await driftDetect(
          driftContext({ sections: [limits({ warningThresholdPercent: 80 })] }),
        )
        expect(calls[2].path).toBe(THRESHOLD_PATH)
        return res
      },
    )

    const diff = result.diffs.find((d) => d.field === 'warningThresholdPercent')
    expect(diff?.expected).toBe(80)
    expect(diff?.actual).toBe(45)
    expect(diff?.severity).toBe('warning')
  })

  it('reports an unset live threshold as "not set"', async () => {
    const result = await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({})], async () =>
      driftDetect(driftContext({ sections: [limits({ warningThresholdPercent: 80 })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'warningThresholdPercent')
    expect(diff?.actual).toBe('not set')
  })

  it('collects every drift in one pass rather than stopping at the first', async () => {
    const result = await withFetch(
      [
        ok({ notificationsEnabled: false }),
        ok({ defaultMode: 'DISABLE', useCaseModeOverrides: { LOGIN_PAGE: 'DISABLE' } }),
        ok({ warningThreshold: 45 }),
      ],
      async () => driftDetect(driftContext({ sections: [limits({ warningThresholdPercent: 80 })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(4)
  })

  it('reports an unreadable singleton as one critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [limits()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('rate-limit-settings')
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].actual).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('discards drift already found when a later read fails — the report is all-or-nothing', async () => {
    const result = await withFetch(
      [ok({ notificationsEnabled: false }), apiError('Okta is down', 503)],
      async () => driftDetect(driftContext({ sections: [limits()] })),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('rate-limit-settings')
  })

  it('makes no System Log call — this config type attaches no drift actor', async () => {
    await withFetch([ok({ notificationsEnabled: false }), ok(LIVE_PER_CLIENT)], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [limits()] }))

      expect(result.hasDrift).toBe(true)
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
      expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
    })
  })
})
