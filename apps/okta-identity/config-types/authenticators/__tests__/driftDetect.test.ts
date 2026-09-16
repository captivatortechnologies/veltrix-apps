// =============================================================================
// authenticators — driftDetect, driven against the fake Okta org.
//
// Drift on an authenticator is a factor turned off by hand, or a provider
// re-pointed at somebody else's Duo tenant. The subtlety that matters: Okta never
// returns the write-only provider secrets, so comparing them would report drift
// on every run — they must be stripped from BOTH sides. And detection must never
// write.
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

function authenticator(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Email',
    fields: { key: 'okta_email', name: 'Email', status: 'ACTIVE', ...fields },
  }
}

const IN_SYNC = {
  id: 'aut-1',
  key: 'okta_email',
  type: 'email',
  name: 'Email',
  status: 'ACTIVE',
  settings: { allowedFor: 'any' },
}

describe('authenticators driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [authenticator()], credential: null }),
      )

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [authenticator()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean authenticator as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [authenticator()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/authenticators')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [authenticator()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags an authenticator that has disappeared from the org as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [authenticator()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('okta_email')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags settings loosened out of band while letting server defaults through', async () => {
    const spec = authenticator({ settingsJson: '{"allowedFor":"any"}' })

    const drifted = await withFetch(
      [ok([{ ...IN_SYNC, settings: { allowedFor: 'recovery' } }])],
      async () => driftDetect(driftContext({ sections: [spec] })),
    )
    const diff = drifted.diffs.find((d) => d.field === 'okta_email.settings')
    expect(diff?.severity).toBe('critical')
    expect(String(diff?.actual)).toMatch(/recovery/)

    const clean = await withFetch(
      [ok([{ ...IN_SYNC, settings: { allowedFor: 'any', userVerification: 'PREFERRED' } }])],
      async () => driftDetect(driftContext({ sections: [spec] })),
    )
    expect(clean.hasDrift).toBe(false)
  })

  it('flags a provider re-pointed at another tenant', async () => {
    const result = await withFetch(
      [
        ok([
          {
            id: 'aut-duo',
            key: 'duo',
            name: 'Duo',
            status: 'ACTIVE',
            provider: { type: 'DUO', configuration: { host: 'api-attacker.duosecurity.com' } },
          },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              authenticator({
                key: 'duo',
                name: 'Duo',
                providerJson: '{"type":"DUO","configuration":{"host":"api-x.duosecurity.com"}}',
              }),
            ],
          }),
        ),
    )

    const diff = result.diffs.find((d) => d.field === 'duo.provider')
    expect(diff?.severity).toBe('critical')
    expect(String(diff?.actual)).toMatch(/api-attacker/)
  })

  it('never compares the write-only provider secrets Okta does not return', async () => {
    const result = await withFetch(
      [
        ok([
          {
            id: 'aut-duo',
            key: 'duo',
            name: 'Duo',
            status: 'ACTIVE',
            // Okta returns the host but never the secret.
            provider: { type: 'DUO', configuration: { host: 'api-x.duosecurity.com' } },
          },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              authenticator({
                key: 'duo',
                name: 'Duo',
                providerJson:
                  '{"type":"DUO","configuration":{"host":"api-x.duosecurity.com","secretKey":"sk-live","integrationKey":"ik-live"}}',
              }),
            ],
          }),
        ),
    )

    // A secret that can never be read back must never produce permanent drift.
    expect(result.hasDrift).toBe(false)
    expect(JSON.stringify(result).includes('sk-live')).toBe(false)
  })

  it('flags an authenticator switched off out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [authenticator()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'okta_email.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not report a status that could never be enforced anyway', async () => {
    const result = await withFetch(
      [ok([{ id: 'aut-pw', key: 'okta_password', name: 'Password', status: 'ACTIVE' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [authenticator({ key: 'okta_password', name: 'Password', status: 'INACTIVE' })],
          }),
        ),
    )

    // okta_password cannot be deactivated, so its ACTIVE state is not drift.
    expect(result.hasDrift).toBe(false)
  })

  it('does not fabricate status drift when the live object reports no status', async () => {
    const result = await withFetch([ok([{ id: 'aut-1', key: 'okta_email', name: 'Email' }])], async () =>
      driftDetect(driftContext({ sections: [authenticator()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('compares a multi-instance authenticator by its (key, name) identity', async () => {
    const result = await withFetch(
      [
        ok([
          { id: 'aut-a', key: 'custom_app', name: 'Acme Push', status: 'ACTIVE' },
          { id: 'aut-b', key: 'custom_app', name: 'Contractor Push', status: 'INACTIVE' },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [authenticator({ key: 'custom_app', name: 'Contractor Push' })],
          }),
        ),
    )

    const diff = result.diffs.find((d) => d.field === 'custom_app::Contractor Push.status')
    expect(diff?.actual).toBe('INACTIVE')
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [authenticator()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('okta_email')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining authenticators after one read fails', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, status: 'INACTIVE' }])],
      async () =>
        driftDetect(
          driftContext({ sections: [authenticator({ key: 'okta_verify' }), authenticator()] }),
        ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0].field).toBe('okta_verify')
    expect(result.diffs[1].field).toBe('okta_email.status')
  })

  it('ignores a section with no key', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Blank', fields: { key: '' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
