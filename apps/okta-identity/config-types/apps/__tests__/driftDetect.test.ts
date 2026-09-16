// =============================================================================
// apps — driftDetect, driven against the fake Okta org.
//
// Two things make this comparison subtle, and both are load-bearing. Okta injects
// its own defaults into every app blob, so the authored blob is compared as a
// SUBSET — otherwise every clean app would read as drift. And the credentials
// secrets (client_secret, signing.*, x5c) are WRITE-ONLY: Okta never returns
// them, so they are stripped from BOTH sides before diffing, or an in-sync app
// would report drift forever. The tests pin both, plus that detection writes
// nothing.
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

function app(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Salesforce section',
    fields: { label: 'Salesforce', signOnMode: 'SAML_2_0', status: 'ACTIVE', ...fields },
  }
}

const IN_SYNC = {
  id: '0oaLIVE',
  label: 'Salesforce',
  signOnMode: 'SAML_2_0',
  status: 'ACTIVE',
  settings: { signOn: { ssoAcsUrl: 'https://acme.test/acs' } },
}

describe('apps driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [app()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [app()], hostname: '' }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean app as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(
        driftContext({
          sections: [app({ settingsJson: '{"signOn":{"ssoAcsUrl":"https://acme.test/acs"}}' })],
        }),
      )
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/apps')
      expect(calls[0].query.q).toBe('Salesforce')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      await driftDetect(driftContext({ sections: [app()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted app as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [app()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Salesforce')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('accepts the server defaults Okta injects alongside the authored settings', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            settings: {
              signOn: { ssoAcsUrl: 'https://acme.test/acs', audience: 'auto-added-by-okta' },
              app: {},
            },
          },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [app({ settingsJson: '{"signOn":{"ssoAcsUrl":"https://acme.test/acs"}}' })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a re-pointed ACS URL as critical drift — the SSO redirect target', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { signOn: { ssoAcsUrl: 'https://evil.test/acs' } } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [app({ settingsJson: '{"signOn":{"ssoAcsUrl":"https://acme.test/acs"}}' })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Salesforce.settings')
    expect(diff?.severity).toBe('critical')
    expect(diff?.actual).toMatch(/evil.test/)
  })

  it('does not compare a blob the canvas never authored', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, visibility: { hide: { iOS: true } }, profile: { owner: 'someone' } }])],
      async () => driftDetect(driftContext({ sections: [app()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never reports the write-only client secret as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, credentials: { oauthClient: { client_id: '0oaCID' } } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              app({
                credentialsJson: '{"oauthClient":{"client_id":"0oaCID","client_secret":"s3cr3t"}}',
              }),
            ],
          }),
        ),
    )

    // Okta never echoes client_secret back, so keeping it would report drift forever.
    expect(result.hasDrift).toBe(false)
  })

  it('never reports write-only signing key material as drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, credentials: {} }])], async () =>
      driftDetect(
        driftContext({
          sections: [app({ credentialsJson: '{"signing":{"kid":"abc","x5c":["MIIC..."]}}' })],
        }),
      ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('still flags a rewritten username template — a credentials field Okta does return', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, credentials: { userNameTemplate: { template: '${source.email}' } } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              app({ credentialsJson: '{"userNameTemplate":{"template":"${source.login}"}}' }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Salesforce.credentials')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('ignores embedded x5c certificate material inside settings', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { signOn: { ssoAcsUrl: 'https://acme.test/acs' } } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              app({
                settingsJson:
                  '{"signOn":{"ssoAcsUrl":"https://acme.test/acs","x5c":["MIICert"]}}',
              }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags an app deactivated out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [app()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Salesforce.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('ignores an unparseable authored blob rather than reporting phantom drift', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [app({ profileJson: 'not json' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an ambiguous label as a diff rather than throwing', async () => {
    const result = await withFetch([ok([IN_SYNC, { ...IN_SYNC, id: '0oaTWIN' }])], async () =>
      driftDetect(driftContext({ sections: [app()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(result.diffs[0].actual).toMatch(/Ambiguous match/)
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('reports an unreadable org as a diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [app()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining apps after one is unreadable', async () => {
    const result = await withFetch([apiError('Okta is down', 503), EMPTY_LIST], async (calls) => {
      const res = await driftDetect(
        driftContext({ sections: [app(), { ...app({ label: 'Workday' }), name: 'Workday section' }] }),
      )
      expect(calls).toHaveLength(2)
      return res
    })

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('Workday')
  })

  it('never inspects an app the deployed config did not fully declare', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [app(), app({ signOnMode: '' })] }))
      expect(calls).toHaveLength(1)
    })
  })
})
