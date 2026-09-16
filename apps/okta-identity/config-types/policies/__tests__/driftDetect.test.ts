// =============================================================================
// policies — driftDetect, driven against the fake Okta org.
//
// Drift on a policy is somebody widening the door by hand: a sign-on policy
// deactivated, its group scoping re-pointed, a password rule loosened. The tests
// assert each drift shape the handler actually compares, that an unreadable
// policy is REPORTED rather than thrown, that detection never writes, and that
// the System Log attribution blames the human — never Veltrix's own deploy.
// =============================================================================

import driftDetect from '../driftDetect'
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

function policy(fields: Record<string, unknown> = {}, name = 'Corporate sign-on'): CanvasItemInput {
  return {
    name,
    fields: {
      type: 'OKTA_SIGN_ON',
      name,
      description: 'Sign-on policy for staff',
      status: 'ACTIVE',
      groupIncludeIds: [],
      ...fields,
    },
  }
}

const LABEL = 'OKTA_SIGN_ON:Corporate sign-on'

const IN_SYNC = {
  id: 'pol-1',
  type: 'OKTA_SIGN_ON',
  name: 'Corporate sign-on',
  description: 'Sign-on policy for staff',
  status: 'ACTIVE',
  system: false,
  priority: 3,
  conditions: {},
}

describe('policies driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [policy()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [policy()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean policy as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [policy()] }))
      // One list call and nothing else — no attribution query when nothing drifted.
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/policies')
      expect(calls[0].query.type).toBe('OKTA_SIGN_ON')
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

  it('flags a deleted policy as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a rewritten description as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, description: 'Tampered' }])],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.description`)
    expect(diff?.expected).toBe('Sign-on policy for staff')
    expect(diff?.actual).toBe('Tampered')
    expect(diff?.severity).toBe('critical')
  })

  it('reports a cleared description as "not set" on both sides rather than empty strings', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, description: '' }])], async () =>
      driftDetect(driftContext({ sections: [policy({ description: 'Sign-on policy for staff' })] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.description`)
    expect(diff?.actual).toBe('not set')
  })

  it('flags a re-pointed group scoping — the widened-door shape', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { people: { groups: { include: ['grp-everyone'] } } } }])],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find(
      (d) => d.field === `${LABEL}.conditions.people.groups.include`,
    )
    expect(diff?.expected).toBe('all users')
    expect(diff?.actual).toBe('grp-everyone')
    expect(diff?.severity).toBe('critical')
  })

  it('ignores group ordering — the same set in another order is not drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, conditions: { people: { groups: { include: ['grp-b', 'grp-a'] } } } }])],
      async () => driftDetect(driftContext({ sections: [policy({ groupIncludeIds: ['grp-a', 'grp-b'] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags loosened settings while letting Okta server defaults through', async () => {
    const spec = policy(
      { type: 'PASSWORD', settingsJson: '{"password":{"complexity":{"minLength":12}}}' },
      'Strong passwords',
    )

    const drifted = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            type: 'PASSWORD',
            name: 'Strong passwords',
            settings: { password: { complexity: { minLength: 4 } } },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [spec] })),
    )
    const diff = drifted.diffs.find((d) => d.field === 'PASSWORD:Strong passwords.settings')
    expect(diff?.severity).toBe('critical')
    expect(diff?.actual).toMatch(/minLength":4/)

    const clean = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            type: 'PASSWORD',
            name: 'Strong passwords',
            // The declared keys are present; the extra server-populated ones must
            // not read as drift.
            settings: {
              password: { complexity: { minLength: 12, excludeUsername: true }, age: { maxAgeDays: 90 } },
            },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [spec] })),
    )
    expect(clean.hasDrift).toBe(false)
  })

  it('never compares settings for OKTA_SIGN_ON, which has none', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { anything: true } }])],
      async () => driftDetect(driftContext({ sections: [policy({ settingsJson: '{"ignored":true}' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a policy deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.status`)
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('treats a blank canvas status as the ACTIVE default when comparing', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [policy({ status: '' })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('flags a rule that was removed from the policy as info drift', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ id: 'rul-9', name: 'Some other rule' }])],
      async (calls) => {
        const res = await driftDetect(
          driftContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] }),
        )
        expect(calls[1].path).toBe('/policies/pol-1/rules')
        return res
      },
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.rules.Require MFA`)
    expect(diff?.expected).toBe('present')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('info')
  })

  it('flags an extra rule added out of band through the rule count', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ id: 'rul-1', name: 'Require MFA' }, { id: 'rul-2', name: 'Bypass' }])],
      async () =>
        driftDetect(driftContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.rules.count`)
    expect(diff?.expected).toBe(1)
    expect(diff?.actual).toBe(2)
    expect(diff?.severity).toBe('info')
  })

  it('does not read the rules at all when the canvas declares none', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [policy()] }))
      expect(calls.some((c) => c.path.includes('/rules'))).toBe(false)
    })
  })

  it('reports an unreadable policy as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe(LABEL)
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable rule list as drift on the policy rather than throwing', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), apiError('Insufficient permissions', 403)],
      async () =>
        driftDetect(driftContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    expect(String(diff?.actual)).toMatch(/Failed to list rules/)
  })

  it('keeps checking the remaining policies after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, status: 'INACTIVE' }])],
      async () =>
        driftDetect(driftContext({ sections: [policy({}, 'First'), policy()] })),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0].field).toBe('OKTA_SIGN_ON:First')
    expect(result.diffs[1].field).toBe(`${LABEL}.status`)
  })

  it('attributes a drift to the admin who made the out-of-band change', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'policy.lifecycle.deactivate' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [policy()] }))
        const log = calls.find((c) => c.path === '/logs')
        expect(log).toBeDefined()
        // The reliable filter is by live object id, not a free-text name search.
        expect(log?.query.filter).toBe('target.id eq "pol-1"')
        return res
      },
    )

    const actor = (result.diffs[0] as { actor?: { email?: string; eventType?: string } }).actor
    expect(actor?.email).toBe('nina@example.com')
    expect(actor?.eventType).toBe('policy.lifecycle.deactivate')
  })

  it('falls back to a name query when the policy is gone and has no live id', async () => {
    await withFetch([EMPTY_LIST, ok([logEvent({ eventType: 'policy.lifecycle.delete' })])], async (calls) => {
      await driftDetect(driftContext({ sections: [policy()] }))

      const log = calls.find((c) => c.path === '/logs')
      expect(log?.query.q).toBe('Corporate sign-on')
      expect(log?.query.filter).toBeUndefined()
    })
  })

  it("does not blame Veltrix's own deploy identity for the drift", async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE' }]),
        ok([logEvent({ login: ADMIN_LOGIN, eventType: 'policy.lifecycle.deactivate' })]),
      ],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('still reports the drift when attribution itself fails', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, status: 'INACTIVE' }]), apiError('System log unavailable', 500)],
      async () => driftDetect(driftContext({ sections: [policy()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe(`${LABEL}.status`)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('attributes every diff a single policy produced in one log query', async () => {
    const result = await withFetch(
      [
        ok([{ ...IN_SYNC, status: 'INACTIVE', description: 'Tampered' }]),
        ok([logEvent({ login: 'nina@example.com', eventType: 'policy.lifecycle.update' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [policy()] }))
        expect(calls.filter((c) => c.path === '/logs')).toHaveLength(1)
        return res
      },
    )

    expect(result.diffs).toHaveLength(2)
    for (const diff of result.diffs) {
      expect((diff as { actor?: { email?: string } }).actor?.email).toBe('nina@example.com')
    }
  })

  it('ignores a section with no type or name', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
