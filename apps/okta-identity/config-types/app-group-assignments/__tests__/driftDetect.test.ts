// =============================================================================
// app-group-assignments — driftDetect, driven against the fake Okta org.
//
// Drift here is an access grant changed by hand: a group unassigned from an app,
// a priority reordered, an attribute override rewritten. The profile comparison
// is deliberately a SUBSET match so app-injected defaults do not read as drift —
// the tests pin that, and pin that detection never writes and never inspects an
// assignment the deployed config did not declare.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function assignment(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering gets Salesforce',
    fields: { appId: '0oaAPP', groupId: '00gENG', ...fields },
  }
}

const IN_SYNC = { id: '00gENG', priority: 5, profile: { role: 'user' } }

describe('app-group-assignments driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [assignment()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [assignment()], hostname: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean assignment as in sync', async () => {
    const result = await withFetch([ok(IN_SYNC)], async (calls) => {
      const res = await driftDetect(
        driftContext({ sections: [assignment({ priority: 5, profileJson: '{"role":"user"}' })] }),
      )
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/apps/0oaAPP/groups/00gENG')
      expect(calls[0].method).toBe('GET')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([notFound()], async (calls) => {
      await driftDetect(driftContext({ sections: [assignment()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a group unassigned out of band as critical drift', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [assignment()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('0oaAPP:00gENG')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('does not compare a priority the canvas left blank — Okta owns it', async () => {
    const result = await withFetch([ok({ id: '00gENG', priority: 99 })], async () =>
      driftDetect(driftContext({ sections: [assignment()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a reordered priority as a warning when one was authored', async () => {
    const result = await withFetch([ok({ id: '00gENG', priority: 99 })], async () =>
      driftDetect(driftContext({ sections: [assignment({ priority: 5 })] })),
    )

    const diff = result.diffs.find((d) => d.field === '0oaAPP:00gENG.priority')
    expect(diff?.expected).toBe(5)
    expect(diff?.actual).toBe(99)
    expect(diff?.severity).toBe('warning')
  })

  it('renders a priority Okta no longer reports as "not set"', async () => {
    const result = await withFetch([ok({ id: '00gENG' })], async () =>
      driftDetect(driftContext({ sections: [assignment({ priority: 5 })] })),
    )

    expect(result.diffs[0].actual).toBe('not set')
  })

  it('accepts app-injected defaults alongside the authored profile keys', async () => {
    const result = await withFetch(
      [ok({ id: '00gENG', profile: { role: 'admin', samlRoles: ['a'], injectedByApp: true } })],
      async () =>
        driftDetect(driftContext({ sections: [assignment({ profileJson: '{"role":"admin"}' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags an authored profile attribute rewritten out of band', async () => {
    const result = await withFetch(
      [ok({ id: '00gENG', profile: { role: 'superadmin' } })],
      async () =>
        driftDetect(driftContext({ sections: [assignment({ profileJson: '{"role":"admin"}' })] })),
    )

    const diff = result.diffs.find((d) => d.field === '0oaAPP:00gENG.profile')
    expect(diff?.expected).toBe('{"role":"admin"}')
    expect(diff?.actual).toBe('{"role":"superadmin"}')
    expect(diff?.severity).toBe('warning')
  })

  it('flags an authored profile attribute that has been removed entirely', async () => {
    const result = await withFetch([ok({ id: '00gENG' })], async () =>
      driftDetect(driftContext({ sections: [assignment({ profileJson: '{"role":"admin"}' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].actual).toBe('{}')
  })

  it('compares nested profile objects by value, not by key order', async () => {
    const result = await withFetch(
      [ok({ id: '00gENG', profile: { entitlements: { b: 2, a: 1 } } })],
      async () =>
        driftDetect(
          driftContext({
            sections: [assignment({ profileJson: '{"entitlements":{"a":1,"b":2}}' })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('ignores an unparseable authored profile rather than reporting phantom drift', async () => {
    const result = await withFetch([ok({ id: '00gENG', profile: { role: 'user' } })], async () =>
      driftDetect(driftContext({ sections: [assignment({ profileJson: 'not json' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable assignment as a diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [assignment()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].severity).toBe('critical')
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining assignments after one is unreadable', async () => {
    const result = await withFetch([apiError('Okta is down', 503), notFound()], async (calls) => {
      const res = await driftDetect(
        driftContext({ sections: [assignment(), assignment({ groupId: '00gSALES' })] }),
      )
      expect(calls).toHaveLength(2)
      return res
    })

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('0oaAPP:00gSALES')
  })

  it('never inspects an assignment the deployed config did not declare', async () => {
    await withFetch([ok(IN_SYNC)], async (calls) => {
      await driftDetect(
        driftContext({ sections: [assignment(), assignment({ appId: '', groupId: '00gX' })] }),
      )

      expect(calls).toHaveLength(1)
      expect(calls.some((c) => c.path === '/apps/0oaAPP/groups')).toBe(false)
    })
  })
})
