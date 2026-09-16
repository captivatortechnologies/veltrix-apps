// =============================================================================
// trusted-origins — driftDetect, driven against the fake Okta org.
//
// Drift here is a web origin quietly gaining trust it was never granted: a
// re-pointed origin URL, an added IFRAME_EMBED or REDIRECT scope. Both are
// CRITICAL, and detection must report them without ever writing.
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

function origin(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Corp SPA',
    fields: {
      name: 'Corp SPA',
      origin: 'https://app.example.com',
      scopes: ['CORS', 'REDIRECT'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'tosLIVE',
  name: 'Corp SPA',
  origin: 'https://app.example.com',
  scopes: [{ type: 'CORS' }, { type: 'REDIRECT' }],
  status: 'ACTIVE',
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/trustedOrigins/tosLIVE` } },
}

describe('trusted-origins driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [origin()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [origin()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching origin as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [origin()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/trustedOrigins')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [origin()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('ignores server-managed fields so they can never read as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-09T00:00:00.000Z', lastUpdatedBy: '00uSOMEONE' }])],
      async () => driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted trusted origin as critical drift', async () => {
    const result = await withFetch([ok([])], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Corp SPA')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed origin URL as critical drift — the takeover shape', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, origin: 'https://attacker.evil.test' }])], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp SPA.origin')
    expect(diff?.expected).toBe('https://app.example.com')
    expect(diff?.actual).toBe('https://attacker.evil.test')
    expect(diff?.severity).toBe('critical')
  })

  it('flags an added scope as critical drift — the origin gained trust nobody granted', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, scopes: [{ type: 'CORS' }, { type: 'REDIRECT' }, { type: 'IFRAME_EMBED' }] }])],
      async () => driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Corp SPA.scopes')
    expect(diff?.severity).toBe('critical')
    expect(diff?.expected).toEqual(['CORS', 'REDIRECT'])
    expect(diff?.actual).toEqual(['CORS', 'IFRAME_EMBED', 'REDIRECT'])
  })

  it('flags a revoked scope as critical drift too', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, scopes: [{ type: 'CORS' }] }])], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp SPA.scopes')
    expect(diff?.actual).toEqual(['CORS'])
  })

  it('compares scopes order-insensitively', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, scopes: [{ type: 'REDIRECT' }, { type: 'CORS' }] }])],
      async () => driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('does not read a trailing slash the author typed as drift', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [origin({ origin: 'https://app.example.com/' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags an origin deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Corp SPA.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('never reads the name as drift — it is the identity the match is made on', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.name'))).toHaveLength(0)
  })

  it('reports an unreadable origin list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [origin()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Corp SPA')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps comparing the remaining origins when one lookup fails', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, name: 'Partner SPA' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [origin(), { ...origin({ name: 'Partner SPA' }), name: 'Partner SPA' }],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Corp SPA')
  })

  it('ignores a section that grants no scope rather than flagging it as drift', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [origin({ scopes: [] })] }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('never inspects a trusted origin the deployed config does not declare', async () => {
    await withFetch([ok([IN_SYNC, { id: 'tosOTHER', name: 'Untouched' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [origin()] }))
      expect(result.hasDrift).toBe(false)
      expect(calls.some((c) => c.path.includes('tosOTHER'))).toBe(false)
    })
  })
})
