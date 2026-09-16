// =============================================================================
// groups — driftDetect, driven against the fake Okta org.
//
// Drift on a group is somebody changing an access grant out of band: a deleted
// group, a rewritten description, a member added by hand. The tests assert what
// is reported, who it is attributed to, and — just as important — what is never
// touched: drift detection writes nothing, and it never reads the membership of
// a group that did not opt into membership management.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  ADMIN_LOGIN,
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  logEvent,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function group(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering section',
    fields: {
      name: 'Engineering',
      description: 'All engineers',
      manageMembership: false,
      memberUserIds: [],
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: '00gLIVE',
  type: 'OKTA_GROUP',
  profile: { name: 'Engineering', description: 'All engineers' },
}

describe('groups driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [group()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [group()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean group as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [group()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/groups')
      expect(calls[0].query.filter).toBe('type eq "OKTA_GROUP"')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch(
      [ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Changed by hand' } }]), EMPTY_LIST],
      async (calls) => {
        await driftDetect(driftContext({ sections: [group()] }))
        expect(writeCalls(calls)).toHaveLength(0)
      },
    )
  })

  it('flags a deleted group as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST, EMPTY_LIST], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [group()] }))
      // No live id to filter the log by — attribution falls back to a name query.
      const log = calls.find((c) => c.path === '/logs')
      expect(log?.query.q).toBe('Engineering')
      return res
    })

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Engineering')
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('treats a same-named group of another type as missing, not as a match', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, type: 'APP_GROUP' }]), EMPTY_LIST],
      async () => driftDetect(driftContext({ sections: [group()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].actual).toBe('missing')
  })

  it('flags a description rewritten out of band', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Changed by hand' } }]),
        EMPTY_LIST,
      ],
      async () => driftDetect(driftContext({ sections: [group()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Engineering.description')
    expect(diff?.expected).toBe('All engineers')
    expect(diff?.actual).toBe('Changed by hand')
    expect(diff?.severity).toBe('critical')
  })

  it('renders a cleared description as "not set" on both sides', async () => {
    const cleared = await withFetch(
      [ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: null } }]), EMPTY_LIST],
      async () => driftDetect(driftContext({ sections: [group()] })),
    )
    expect(cleared.diffs[0].actual).toBe('not set')

    const added = await withFetch(
      [ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Added by hand' } }]), EMPTY_LIST],
      async () => driftDetect(driftContext({ sections: [group({ description: '' })] })),
    )
    expect(added.diffs[0].expected).toBe('not set')
  })

  it('never reads membership for a group that did not opt into management', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [group({ memberUserIds: ['00u1'] })] }),
      )

      expect(result.hasDrift).toBe(false)
      expect(calls.some((c) => c.path.includes('/users'))).toBe(false)
    })
  })

  it('reports membership drift as a warning when the group opted in', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ id: '00uSNEAK' }, { id: '00uKEEP' }]), EMPTY_LIST],
      async () =>
        driftDetect(
          driftContext({
            sections: [group({ manageMembership: true, memberUserIds: ['00uKEEP'] })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Engineering.members')
    expect(diff?.expected).toBe('00uKEEP')
    expect(diff?.actual).toMatch(/00uKEEP, 00uSNEAK/)
    expect(diff?.actual).toMatch(/rule-assigned members may be included/)
    expect(diff?.severity).toBe('warning')
  })

  it('does not flag membership that differs only in order', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ id: '00uB' }, { id: '00uA' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [group({ manageMembership: true, memberUserIds: ['00uA', '00uB'] })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('skips the membership check rather than reporting a phantom diff on a 404', async () => {
    const result = await withFetch([ok([IN_SYNC]), notFound()], async () =>
      driftDetect(
        driftContext({ sections: [group({ manageMembership: true, memberUserIds: ['00u1'] })] }),
      ),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports unreadable membership as a diff instead of throwing', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), apiError('Insufficient permissions', 403), EMPTY_LIST],
      async () =>
        driftDetect(
          driftContext({ sections: [group({ manageMembership: true, memberUserIds: ['00u1'] })] }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Engineering.members')
    expect(diff?.expected).toBe('readable')
    expect(diff?.actual).toMatch(/unreadable/)
    expect(diff?.severity).toBe('warning')
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreachable org as one critical diff rather than throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [group()] }))
      // It stops at the failed list — no per-group probing against a dead org.
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('okta-org')
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].severity).toBe('critical')
    expect(leaksToken(result)).toBe(false)
  })

  it('attributes a drift to the admin who made the out-of-band change', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Changed by hand' } }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'group.lifecycle.update' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [group()] }))
        const log = calls.find((c) => c.path === '/logs')
        expect(log).toBeDefined()
        // The reliable filter is by live object id, not a free-text name search.
        expect(log?.query.filter).toBe('target.id eq "00gLIVE"')
        return res
      },
    )

    const actor = (result.diffs[0] as { actor?: { email?: string; eventType?: string } }).actor
    expect(actor?.email).toBe('nina@example.com')
    expect(actor?.eventType).toBe('group.lifecycle.update')
  })

  it("does not blame Veltrix's own deploy identity for the drift", async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Changed by deploy' } }]),
        ok([logEvent({ login: ADMIN_LOGIN, eventType: 'group.lifecycle.update' })]),
      ],
      async () => driftDetect(driftContext({ sections: [group()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('still reports the drift when the System Log query itself fails', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, profile: { name: 'Engineering', description: 'Changed by hand' } }]),
        apiError('System log unavailable', 500),
      ],
      async () => driftDetect(driftContext({ sections: [group()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('does not query the System Log at all for a group with no drift', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [group()] }))
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
    })
  })
})
