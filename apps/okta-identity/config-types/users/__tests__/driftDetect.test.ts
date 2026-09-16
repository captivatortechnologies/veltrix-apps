// =============================================================================
// users — driftDetect, driven against the fake Okta org.
//
// Drift on a user is somebody changing an account out of band: a deleted
// break-glass admin, a re-pointed email, an account quietly re-activated. The
// tests assert what is reported AND what is never touched — an undeclared user
// must never be read.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  ADMIN_LOGIN,
  apiError,
  driftContext,
  leaksToken,
  logEvent,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function user(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Break-glass admin',
    fields: {
      login: 'breakglass@example.com',
      email: 'breakglass@example.com',
      firstName: 'Break',
      lastName: 'Glass',
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: '00uLIVE',
  status: 'ACTIVE',
  profile: {
    login: 'breakglass@example.com',
    email: 'breakglass@example.com',
    firstName: 'Break',
    lastName: 'Glass',
  },
}

describe('users driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [user()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config, not the current canvas, and reports a clean user as in sync', async () => {
    const result = await withFetch([ok(IN_SYNC)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [user()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/users/breakglass%40example.com')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok({ ...IN_SYNC, status: 'SUSPENDED' })], async (calls) => {
      await driftDetect(driftContext({ sections: [user()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted user as critical drift', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [user()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'breakglass@example.com')
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed email — the account-takeover shape', async () => {
    const result = await withFetch(
      [ok({ ...IN_SYNC, profile: { ...IN_SYNC.profile, email: 'attacker@evil.test' } })],
      async () => driftDetect(driftContext({ sections: [user()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'breakglass@example.com.email')
    expect(diff?.expected).toBe('breakglass@example.com')
    expect(diff?.actual).toBe('attacker@evil.test')
  })

  it('flags a user that was suspended out of band', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, status: 'SUSPENDED' })], async () =>
      driftDetect(driftContext({ sections: [user()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'breakglass@example.com.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('SUSPENDED')
    expect(diff?.severity).toBe('warning')
  })

  it('accepts any active-like live status for a user declared ACTIVE', async () => {
    for (const status of ['ACTIVE', 'PROVISIONED', 'RECOVERY', 'PASSWORD_EXPIRED', 'LOCKED_OUT']) {
      const result = await withFetch([ok({ ...IN_SYNC, status })], async () =>
        driftDetect(driftContext({ sections: [user()] })),
      )
      expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
    }
  })

  it('does not flag STAGED, which is a create-only state', async () => {
    const result = await withFetch([ok({ ...IN_SYNC, status: 'DEPROVISIONED' })], async () =>
      driftDetect(driftContext({ sections: [user({ status: 'STAGED' })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('reports an unreadable user as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [user()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].actual).toMatch(/unreadable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('attributes a drift to the admin who made the out-of-band change', async () => {
    const result = await withFetch(
      [
        ok({ ...IN_SYNC, status: 'SUSPENDED' }),
        ok([logEvent({ login: 'nina@example.com', eventType: 'user.lifecycle.suspend' })]),
      ],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [user()] }))
        const log = calls.find((c) => c.path === '/logs')
        expect(log).toBeDefined()
        // The reliable filter is by live object id, not a free-text name search.
        expect(log?.query.filter).toBe('target.id eq "00uLIVE"')
        return res
      },
    )

    const actor = (result.diffs[0] as { actor?: { email?: string; eventType?: string } }).actor
    expect(actor?.email).toBe('nina@example.com')
    expect(actor?.eventType).toBe('user.lifecycle.suspend')
  })

  it('does not blame Veltrix\'s own deploy identity for the drift', async () => {
    const result = await withFetch(
      [
        ok({ ...IN_SYNC, status: 'SUSPENDED' }),
        ok([logEvent({ login: ADMIN_LOGIN, eventType: 'user.lifecycle.suspend' })]),
      ],
      async () => driftDetect(driftContext({ sections: [user()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('still reports the drift when attribution itself fails', async () => {
    const result = await withFetch(
      [ok({ ...IN_SYNC, status: 'SUSPENDED' }), apiError('System log unavailable', 500)],
      async () => driftDetect(driftContext({ sections: [user()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
  })

  it('never reads a user that is not declared in the deployed config', async () => {
    await withFetch([ok(IN_SYNC)], async (calls) => {
      await driftDetect(driftContext({ sections: [user()] }))
      expect(calls.some((c) => c.path === '/users')).toBe(false)
    })
  })
})
