// =============================================================================
// auth-server-policies — driftDetect, driven against the fake Okta org.
//
// Drift here is somebody widening who may ask for a token: a policy re-scoped
// from one OAuth client to ALL_CLIENTS, a policy deactivated so a broader one
// takes over, a rule silently removed. The tests assert each drift shape the
// handler actually compares, the deliberate non-drift (extra live rules are
// never pruned, so they are not drift), that an unreadable parent is reported
// rather than thrown, and that detection writes NOTHING.
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

function policy(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner access',
    fields: {
      authServerId: 'default',
      name: 'Partner access',
      description: 'Who may ask for a partner token',
      status: 'ACTIVE',
      clientInclude: ['0oaPARTNER'],
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: '00pLIVE',
  type: 'OAUTH_AUTHORIZATION_POLICY',
  name: 'Partner access',
  description: 'Who may ask for a partner token',
  status: 'ACTIVE',
  priority: 1,
  system: false,
  conditions: { clients: { include: ['0oaPARTNER'] } },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: {} },
}

describe('auth-server-policies driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [policy()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [policy()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean policy as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [policy()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/authorizationServers/default/policies')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [policy()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not read Okta-managed readOnly fields as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-01T00:00:00.000Z', _links: { self: { href: 'x' } } }])],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted policy as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('default:Partner access')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a policy re-scoped to every OAuth client — the quiet widening', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { clients: { include: ['ALL_CLIENTS'] } } }])],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'default:Partner access.conditions.clients.include')
    expect(diff?.expected).toBe('0oaPARTNER')
    expect(diff?.actual).toBe('ALL_CLIENTS')
    expect(diff?.severity).toBe('critical')
  })

  it('treats an unscoped canvas as ALL_CLIENTS when comparing', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { clients: { include: ['ALL_CLIENTS'] } } }])],
      async () => driftDetect(driftContext({ sections: [policy({ clientInclude: [] })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.clients.include'))).toHaveLength(0)
  })

  it('reports client scoping stripped out entirely as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, conditions: {} }])], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find((d) => d.field.endsWith('.conditions.clients.include'))
    expect(diff?.actual).toBe('not set')
  })

  it('ignores the order of the client include set', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { clients: { include: ['0oaB', '0oaA'] } } }])],
      async () => driftDetect(driftContext({ sections: [policy({ clientInclude: ['0oaA', '0oaB'] })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.clients.include'))).toHaveLength(0)
  })

  it('flags a rewritten description', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, description: 'Edited in the admin console' }])],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:Partner access.description')
    expect(diff?.expected).toBe('Who may ask for a partner token')
    expect(diff?.actual).toBe('Edited in the admin console')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a policy deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:Partner access.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('defaults an unauthored status to ACTIVE when comparing', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [policy({ status: '' })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('compares priority only when the canvas authored it', async () => {
    const authored = await withFetch([ok([{ ...IN_SYNC, priority: 7 }])], async () =>
      driftDetect(driftContext({ sections: [policy({ priority: 1 })] })),
    )
    const diff = authored.diffs.find((d) => d.field === 'default:Partner access.priority')
    expect(diff?.expected).toBe(1)
    expect(diff?.actual).toBe(7)
    expect(diff?.severity).toBe('warning')

    const unauthored = await withFetch([ok([{ ...IN_SYNC, priority: 7 }])], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )
    expect(unauthored.diffs.filter((d) => d.field.endsWith('.priority'))).toHaveLength(0)
  })

  it('flags a declared rule that was removed from the policy', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ id: '0prSYS', name: 'Default Rule' }])],
      async (calls) => {
        const res = await driftDetect(
          driftContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Short-lived tokens' }]) })],
          }),
        )
        expect(calls[1].path).toBe('/authorizationServers/default/policies/00pLIVE/rules')
        return res
      },
    )

    const diff = result.diffs.find(
      (d) => d.field === 'default:Partner access.rules.Short-lived tokens',
    )
    expect(diff?.expected).toBe('present')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('info')
  })

  it('does NOT treat an extra live rule as drift — unmodeled rules are never pruned', async () => {
    const result = await withFetch(
      [
        ok([IN_SYNC]),
        ok([
          { id: '0prSYS', name: 'Default Rule' },
          { id: '0prOTHER', name: 'Added by hand' },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({ sections: [policy({ rulesJson: JSON.stringify([{ name: 'Default Rule' }]) })] }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('does not read the rules endpoint at all when no rules are authored', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [policy()] }))
      expect(calls.some((c) => c.path.includes('/rules'))).toBe(false)
    })
  })

  it('reports an unresolvable parent authorization server as critical drift, not a throw', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [policy({ authServerId: 'ausGONE' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('ausGONE:Partner access')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Failed to list policies/)
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable rule list as drift on the policy rather than throwing', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), apiError('Insufficient permissions', 403)],
      async () =>
        driftDetect(
          driftContext({ sections: [policy({ rulesJson: JSON.stringify([{ name: 'Default Rule' }]) })] }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('default:Partner access')
    expect(String(result.diffs[0].actual)).toMatch(/Failed to list rules/)
  })

  it('ignores a section the validator would have rejected', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Bad', fields: { name: 'Orphan policy' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
