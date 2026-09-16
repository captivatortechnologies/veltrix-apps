// =============================================================================
// user-types — driftDetect, driven against the fake Okta org.
//
// The immutable `name` is the match key, so it can never itself read as drift —
// a type whose name changed simply reads as missing, which is the honest answer.
// Everything else that is editable (displayName, description) is compared, the
// server-managed fields are not, and detection never writes.
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

function userType(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Contractor section',
    fields: {
      name: 'contractor',
      displayName: 'Contractor',
      description: 'External contractors',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'otyLIVE',
  name: 'contractor',
  displayName: 'Contractor',
  description: 'External contractors',
  default: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: {},
}

describe('user-types driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [userType()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [userType()], hostname: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean type as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [userType()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/meta/types/user')
      expect(calls[0].method).toBe('GET')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, displayName: 'Changed' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [userType()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('lists the org types once for the whole deployed config', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(
        driftContext({
          sections: [
            userType(),
            { ...userType({ name: 'vendor', displayName: 'Vendor' }), name: 'Vendor section' },
          ],
        }),
      )

      expect(calls).toHaveLength(1)
    })
  })

  it('flags a deleted user type as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [userType()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('contractor')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('reads a type whose immutable name changed as missing, not as a name diff', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, name: 'contractor_v2' }])], async () =>
      driftDetect(driftContext({ sections: [userType()] })),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].actual).toBe('missing')
  })

  it('flags a renamed display name as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, displayName: 'Contract staff' }])], async () =>
      driftDetect(driftContext({ sections: [userType()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'contractor.displayName')
    expect(diff?.expected).toBe('Contractor')
    expect(diff?.actual).toBe('Contract staff')
    expect(diff?.severity).toBe('warning')
  })

  it('renders a cleared display name as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, displayName: '' }])], async () =>
      driftDetect(driftContext({ sections: [userType()] })),
    )

    expect(result.diffs[0].actual).toBe('not set')
  })

  it('flags a description changed out of band, in both directions', async () => {
    const cleared = await withFetch([ok([{ ...IN_SYNC, description: '' }])], async () =>
      driftDetect(driftContext({ sections: [userType()] })),
    )
    const clearedDiff = cleared.diffs.find((d) => d.field === 'contractor.description')
    expect(clearedDiff?.expected).toBe('External contractors')
    expect(clearedDiff?.actual).toBe('not set')

    const added = await withFetch([ok([{ ...IN_SYNC, description: 'Added by hand' }])], async () =>
      driftDetect(driftContext({ sections: [userType({ description: '' })] })),
    )
    const addedDiff = added.diffs.find((d) => d.field === 'contractor.description')
    expect(addedDiff?.expected).toBe('not set')
    expect(addedDiff?.actual).toBe('Added by hand')
    expect(addedDiff?.severity).toBe('warning')
  })

  it('never reports the server-managed id, default flag or timestamps as drift', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            id: 'otyCHANGED',
            default: true,
            lastUpdated: '2026-09-09T00:00:00.000Z',
            createdBy: 'someone',
            _links: { self: { href: 'https://changed.example.test' } },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [userType()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable org as one critical diff rather than throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [userType()] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('user-types')
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].severity).toBe('critical')
    expect(leaksToken(result)).toBe(false)
  })

  it('never inspects a type the deployed config did not fully declare', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(
        driftContext({ sections: [userType(), userType({ name: 'vendor', displayName: '' })] }),
      ),
    )

    expect(result.hasDrift).toBe(false)
  })
})
