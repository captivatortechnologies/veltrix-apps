// =============================================================================
// auth-server-claims — driftDetect, driven against the fake Okta org.
//
// Drift on a claim is a change to what a token ASSERTS: a re-pointed expression
// makes every downstream authorization decision read the wrong attribute, a
// widened scope condition leaks the claim into tokens that never asked for it,
// and a GROUPS filter loosened from EQUALS to CONTAINS quietly grants more. The
// tests assert each shape the handler compares, the deliberate non-drift (an
// Okta-managed system claim is never diffed), and that detection writes NOTHING.
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

function claim(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'department',
    fields: {
      authServerId: 'default',
      name: 'department',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'user.department',
      alwaysIncludeInToken: true,
      status: 'ACTIVE',
      scopeConditions: ['partner.read'],
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'oclLIVE',
  name: 'department',
  status: 'ACTIVE',
  claimType: 'RESOURCE',
  valueType: 'EXPRESSION',
  value: 'user.department',
  alwaysIncludeInToken: true,
  conditions: { scopes: ['partner.read'] },
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: {} },
}

describe('auth-server-claims driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [claim()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [claim()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean claim as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [claim()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/authorizationServers/default/claims')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, value: 'user.somethingElse' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [claim()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not read Okta-managed readOnly fields as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-01T00:00:00.000Z', _links: { self: { href: 'x' } } }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted claim as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [claim()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('default:department')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a re-pointed expression — downstream now authorizes on another attribute', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, value: 'user.title' }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'default:department.value')
    expect(diff?.expected).toBe('user.department')
    expect(diff?.actual).toBe('user.title')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a claim moved from the access token to the ID token', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, claimType: 'IDENTITY' }])], async () =>
      driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.claimType')
    expect(diff?.expected).toBe('RESOURCE')
    expect(diff?.actual).toBe('IDENTITY')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a changed valueType', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, valueType: 'GROUPS' }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.valueType')
    expect(diff?.expected).toBe('EXPRESSION')
    expect(diff?.actual).toBe('GROUPS')
  })

  it('flags a claim forced into every token regardless of scope', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, alwaysIncludeInToken: false }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.alwaysIncludeInToken')
    expect(diff?.expected).toBe(true)
    expect(diff?.actual).toBe(false)
  })

  it('flags widened scope conditions', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { scopes: ['partner.read', 'partner.write'] } }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.conditions')
    expect(diff?.expected).toEqual({ scopes: ['partner.read'] })
    expect(diff?.actual).toEqual({ scopes: ['partner.read', 'partner.write'] })
    expect(diff?.severity).toBe('critical')
  })

  it('reports conditions stripped off the live claim entirely as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, conditions: undefined }])], async () =>
      driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.conditions')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a loosened GROUPS filter operator', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, valueType: 'GROUPS', value: 'eng-', group_filter_type: 'CONTAINS' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              claim({ valueType: 'GROUPS', value: 'eng-', groupFilterType: 'STARTS_WITH' }),
            ],
          }),
        ),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.group_filter_type')
    expect(diff?.expected).toBe('STARTS_WITH')
    expect(diff?.actual).toBe('CONTAINS')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a claim deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [claim()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:department.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('never diffs a live Okta-managed system claim', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, system: true, value: 'user.somethingElse', status: 'INACTIVE' }])],
      async () => driftDetect(driftContext({ sections: [claim()] })),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toEqual([])
  })

  it('reports an unresolvable parent authorization server as critical drift, not a throw', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [claim({ authServerId: 'ausGONE' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('ausGONE:department')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Failed to list claims/)
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [claim()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining claims after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([IN_SYNC])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              claim(),
              { name: 'Second', fields: { authServerId: 'default', name: 'costCenter' } },
            ],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('default:costCenter')
    expect(result.diffs[1].actual).toBe('missing')
  })

  it('ignores a section the validator would have rejected', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Bad', fields: { name: 'orphan' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
