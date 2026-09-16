// =============================================================================
// group-rules — driftDetect, driven against the fake Okta org.
//
// Drift on a group rule is an access grant changed out of band: a widened
// expression, a re-pointed target group, a rule quietly deactivated. Every one of
// those changes who is in a group, so the tests pin each diff shape, the
// attribution, and the fact that drift detection writes nothing.
// =============================================================================

import driftDetect from '../driftDetect'
import { OKTA_EXPRESSION_TYPE } from '../validate'
import {
  ADMIN_LOGIN,
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  logEvent,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function rule(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering rule section',
    fields: {
      name: 'Engineering auto-assign',
      expression: 'user.department=="Engineering"',
      groupIds: ['00gENG'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: '0prLIVE',
  type: 'group_rule',
  status: 'ACTIVE',
  name: 'Engineering auto-assign',
  conditions: { expression: { value: 'user.department=="Engineering"', type: OKTA_EXPRESSION_TYPE } },
  actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
}

describe('group-rules driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [rule()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [rule()], hostname: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean rule as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [rule()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/groups/rules')
      expect(calls[0].method).toBe('GET')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch(
      [ok([{ ...IN_SYNC, status: 'INACTIVE' }]), EMPTY_LIST],
      async (calls) => {
        await driftDetect(driftContext({ sections: [rule()] }))
        expect(writeCalls(calls)).toHaveLength(0)
      },
    )
  })

  it('flags a deleted rule as critical drift and attributes it by name', async () => {
    const result = await withFetch([EMPTY_LIST, EMPTY_LIST], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [rule()] }))
      const log = calls.find((c) => c.path === '/logs')
      expect(log?.query.q).toBe('Engineering auto-assign')
      return res
    })

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Engineering auto-assign')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a widened expression as critical drift — it changes who gets access', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, conditions: { expression: { value: 'user.status=="ACTIVE"' } } }]),
        EMPTY_LIST,
      ],
      async () => driftDetect(driftContext({ sections: [rule()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Engineering auto-assign.expression')
    expect(diff?.expected).toBe('user.department=="Engineering"')
    expect(diff?.actual).toBe('user.status=="ACTIVE"')
    expect(diff?.severity).toBe('critical')
  })

  it('renders a stripped expression as "not set" rather than an empty string', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, conditions: {} }]), EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.diffs[0].actual).toBe('not set')
  })

  it('flags a re-pointed target group as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, actions: { assignUserToGroups: { groupIds: ['00gADMIN'] } } }]), EMPTY_LIST],
      async () => driftDetect(driftContext({ sections: [rule()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Engineering auto-assign.groupIds')
    expect(diff?.expected).toBe('00gENG')
    expect(diff?.actual).toBe('00gADMIN')
    expect(diff?.severity).toBe('critical')
  })

  it('does not flag target groups that differ only in order', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, actions: { assignUserToGroups: { groupIds: ['00gB', '00gA'] } } }])],
      async () => driftDetect(driftContext({ sections: [rule({ groupIds: ['00gA', '00gB'] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a rule deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }]), EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [rule()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Engineering auto-assign.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('reports an INVALID rule as status drift rather than swallowing it', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INVALID' }]), EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].actual).toBe('INVALID')
  })

  it('reports every drifted field of one rule, not just the first', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            status: 'INACTIVE',
            conditions: { expression: { value: 'user.status=="ACTIVE"' } },
            actions: { assignUserToGroups: { groupIds: ['00gADMIN'] } },
          },
        ]),
        EMPTY_LIST,
      ],
      async () => driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.diffs).toHaveLength(3)
  })

  it('reports an unreadable rule list as a diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].severity).toBe('critical')
    expect(leaksToken(result)).toBe(false)
  })

  it('never compares a rule the deployed config did not fully declare', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [rule({ groupIds: [] }), rule({ expression: '' })] }),
      )

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('attributes a drift to the admin who made the out-of-band change', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'group.rule.deactivate' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [rule()] }))
        const log = calls.find((c) => c.path === '/logs')
        // The reliable filter is by live object id, not a free-text name search.
        expect(log?.query.filter).toBe('target.id eq "0prLIVE"')
        return res
      },
    )

    const actor = (result.diffs[0] as { actor?: { email?: string; eventType?: string } }).actor
    expect(actor?.email).toBe('nina@example.com')
    expect(actor?.eventType).toBe('group.rule.deactivate')
  })

  it("does not blame Veltrix's own deploy identity for the drift", async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: ADMIN_LOGIN, eventType: 'group.rule.deactivate' })]),
      ],
      async () => driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('still reports the drift when the System Log query itself fails', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, status: 'INACTIVE' }]), apiError('System log unavailable', 500)],
      async () => driftDetect(driftContext({ sections: [rule()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('does not query the System Log at all for a rule with no drift', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [rule()] }))
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
    })
  })
})
