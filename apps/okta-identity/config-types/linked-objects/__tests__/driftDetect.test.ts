// =============================================================================
// linked-objects — driftDetect, driven against the fake Okta org.
//
// Because a definition is immutable, drift here means somebody deleted and
// recreated it — which silently dropped every user link that used it. A changed
// associated NAME redefines the relationship and is critical; titles and
// descriptions are cosmetic and only warn. Detection never writes.
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

function linkedObject(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Manager relationship',
    fields: {
      primaryName: 'manager',
      primaryTitle: 'Manager',
      associatedName: 'reports',
      associatedTitle: 'Direct reports',
      ...fields,
    },
  }
}

const IN_SYNC = {
  primary: { name: 'manager', title: 'Manager', type: 'USER' },
  associated: { name: 'reports', title: 'Direct reports', type: 'USER' },
  _links: { self: { href: 'https://example.test' } },
}

describe('linked-objects driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [linkedObject()], credential: null }),
      )

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [linkedObject()], hostname: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean definition as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [linkedObject()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/meta/schemas/user/linkedObjects')
      expect(calls[0].method).toBe('GET')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      await driftDetect(driftContext({ sections: [linkedObject()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted definition as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('manager')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a redefined associated name as critical — the relationship changed', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, associated: { name: 'subordinates', title: 'Direct reports' } }])],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'manager.associatedName')
    expect(diff?.expected).toBe('reports')
    expect(diff?.actual).toBe('subordinates')
    expect(diff?.severity).toBe('critical')
  })

  it('does not flag an associated name that differs only in case', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, associated: { name: 'REPORTS', title: 'Direct reports' } }])],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a renamed title as a warning, not a critical', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, primary: { name: 'manager', title: 'Line manager' } }])],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'manager.primaryTitle')
    expect(diff?.expected).toBe('Manager')
    expect(diff?.actual).toBe('Line manager')
    expect(diff?.severity).toBe('warning')
  })

  it('flags a description added or removed out of band as a warning', async () => {
    const added = await withFetch(
      [ok([{ ...IN_SYNC, primary: { name: 'manager', title: 'Manager', description: 'By hand' } }])],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )
    const addedDiff = added.diffs.find((d) => d.field === 'manager.primaryDescription')
    expect(addedDiff?.expected).toBe('not set')
    expect(addedDiff?.actual).toBe('By hand')
    expect(addedDiff?.severity).toBe('warning')

    const removed = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(
        driftContext({ sections: [linkedObject({ associatedDescription: 'Who reports here' })] }),
      ),
    )
    const removedDiff = removed.diffs.find((d) => d.field === 'manager.associatedDescription')
    expect(removedDiff?.expected).toBe('Who reports here')
    expect(removedDiff?.actual).toBe('not set')
  })

  it('never reports the server-managed type or links as drift', async () => {
    const result = await withFetch(
      [
        ok([
          {
            primary: { name: 'manager', title: 'Manager', type: 'USER', extra: 'server-added' },
            associated: { name: 'reports', title: 'Direct reports', type: 'USER' },
            _links: { self: { href: 'https://changed.example.test' } },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports every drifted field of one definition, not just the first', async () => {
    const result = await withFetch(
      [
        ok([
          {
            primary: { name: 'manager', title: 'Line manager' },
            associated: { name: 'subordinates', title: 'Subordinates' },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    expect(result.diffs).toHaveLength(3)
  })

  it('reports an unreadable org as a diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [linkedObject()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].severity).toBe('critical')
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining definitions after one is unreadable', async () => {
    const result = await withFetch([apiError('Okta is down', 503), EMPTY_LIST], async (calls) => {
      const res = await driftDetect(
        driftContext({
          sections: [
            linkedObject(),
            {
              ...linkedObject({ primaryName: 'mentor', associatedName: 'mentees' }),
              name: 'Mentor relationship',
            },
          ],
        }),
      )
      expect(calls).toHaveLength(2)
      return res
    })

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('mentor')
  })

  it('never inspects a definition the deployed config did not fully declare', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(
        driftContext({ sections: [linkedObject(), linkedObject({ associatedName: '' })] }),
      )
      expect(calls).toHaveLength(1)
    })
  })
})
