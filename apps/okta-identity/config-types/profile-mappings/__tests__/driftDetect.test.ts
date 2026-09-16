// =============================================================================
// profile-mappings — driftDetect, driven against the fake Okta org.
//
// Drift here is a quiet rewrite of where a profile attribute comes from — the
// value that later becomes a token claim. The handler compares ONLY the managed
// target properties: a declared expression must be present and match on both
// expression and pushStatus, a property declared for REMOVAL must be absent, and
// an unmanaged property on the same mapping is never inspected. Detection writes
// NOTHING.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const PROPS = {
  department: { expression: 'appuser.department', pushStatus: 'PUSH' },
}

function mapping(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'HR to Okta',
    fields: {
      sourceId: '0oaHRAPP',
      targetId: 'otyDEFAULT',
      propertiesJson: JSON.stringify(PROPS),
      ...fields,
    },
  }
}

const LABEL = 'source "0oaHRAPP" -> target "otyDEFAULT"'
const RESOLVED = { id: 'prm1a2b3c' }

const IN_SYNC = {
  id: 'prm1a2b3c',
  properties: {
    department: { expression: 'appuser.department', pushStatus: 'PUSH' },
    costCenter: { expression: 'appuser.costCenter', pushStatus: 'PUSH' },
  },
}

describe('profile-mappings driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [mapping()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [mapping()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean mapping as in sync', async () => {
    const result = await withFetch([ok([RESOLVED]), ok(IN_SYNC)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [mapping()] }))
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe('/mappings')
      expect(calls[0].query.sourceId).toBe('0oaHRAPP')
      expect(calls[1].path).toBe('/mappings/prm1a2b3c')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch(
      [ok([RESOLVED]), ok({ ...IN_SYNC, properties: { department: { expression: 'appuser.x', pushStatus: 'PUSH' } } })],
      async (calls) => {
        await driftDetect(driftContext({ sections: [mapping()] }))
        expect(writeCalls(calls)).toHaveLength(0)
      },
    )
  })

  it('never inspects an unmanaged property on the same mapping', async () => {
    const result = await withFetch(
      [
        ok([RESOLVED]),
        ok({ ...IN_SYNC, properties: { ...IN_SYNC.properties, costCenter: { expression: 'edited', pushStatus: 'DONT_PUSH' } } }),
      ],
      async () => driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a re-pointed expression as critical drift', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok({ ...IN_SYNC, properties: { department: { expression: 'appuser.title', pushStatus: 'PUSH' } } })],
      async () => driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.department`)
    expect(diff?.expected).toBe('appuser.department (PUSH)')
    expect(diff?.actual).toBe('appuser.title (PUSH)')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a flipped pushStatus even when the expression still matches', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok({ ...IN_SYNC, properties: { department: { expression: 'appuser.department', pushStatus: 'DONT_PUSH' } } })],
      async () => driftDetect(driftContext({ sections: [mapping()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.department`)
    expect(diff?.actual).toBe('appuser.department (DONT_PUSH)')
  })

  it('flags a managed property that was deleted out of band', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok({ ...IN_SYNC, properties: { costCenter: { expression: 'x', pushStatus: 'PUSH' } } })],
      async () => driftDetect(driftContext({ sections: [mapping()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.department`)
    expect(diff?.expected).toBe('present')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a property declared for REMOVAL that is still live — as a warning', async () => {
    const result = await withFetch([ok([RESOLVED]), ok(IN_SYNC)], async () =>
      driftDetect(
        driftContext({
          sections: [
            mapping({
              propertiesJson: JSON.stringify({ department: { expression: null, pushStatus: null } }),
            }),
          ],
        }),
      ),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.department`)
    expect(diff?.expected).toBe('absent')
    expect(diff?.actual).toBe('present')
    expect(diff?.severity).toBe('warning')
  })

  it('reports no drift for a removal that really is absent', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok({ ...IN_SYNC, properties: {} })],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              mapping({
                propertiesJson: JSON.stringify({ department: { expression: null, pushStatus: null } }),
              }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unresolvable mapping as critical drift, not a throw', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(LABEL)
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/No profile mapping exists/)
  })

  it('reports an ambiguous resolve as drift rather than picking one', async () => {
    const result = await withFetch([ok([RESOLVED, { id: 'prmOTHER' }])], async () =>
      driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(String(result.diffs[0].actual)).toMatch(/Ambiguous: 2 profile mappings match/)
  })

  it('reports a mapping that vanished between resolve and read as missing', async () => {
    const result = await withFetch([ok([RESOLVED]), notFound()], async () =>
      driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(LABEL)
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [mapping()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining mappings after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([RESOLVED]), ok(IN_SYNC)],
      async () =>
        driftDetect(
          driftContext({ sections: [mapping(), mapping({ targetId: 'otyCONTRACTOR' })] }),
        ),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(LABEL)
  })

  it('ignores a section with no declared properties', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({
          sections: [
            mapping({ propertiesJson: '' }),
            mapping({ sourceId: '' }),
            mapping({ propertiesJson: '[not json' }),
          ],
        }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
