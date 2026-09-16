// =============================================================================
// apps — deploy, driven against the fake Okta org.
//
// An application instance is where sign-on actually happens, and an app's label
// is neither unique nor filterable, so the whole risk sits in the MATCH: resolve
// the wrong app and a PUT full-replaces somebody else's SSO integration. The
// handler therefore refuses an ambiguous match, refuses a label that already
// exists under a different sign-on mode (name and signOnMode are immutable), and
// never touches a protected Okta system app. These tests pin all three, plus the
// create/update bodies, the lifecycle reconciliation and the rollback state.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
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

const LIVE_APP = {
  id: '0oaLIVE',
  label: 'Salesforce',
  name: 'salesforce_app',
  signOnMode: 'SAML_2_0',
  status: 'ACTIVE',
  settings: { signOn: { ssoAcsUrl: 'https://old.example.test' } },
  visibility: { hide: { iOS: false } },
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  orn: 'orn:okta:idp:00o:apps:0oaLIVE',
  features: [],
  universalLogout: {},
  _links: { accessPolicy: { href: 'https://dev-12345.okta.com/api/v1/policies/rst0PRIOR' } },
  _embedded: {},
}

describe('apps deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [app()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [app()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [app()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [app()] }))

      expect(calls[0].path).toBe('/apps')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].query.q).toBe('Salesforce')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates an app that does not exist, activating it in the same request', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [app()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/apps')
      expect(writes[0].query.activate).toBe('true')
      expect(writes[0].json).toEqual({ label: 'Salesforce', signOnMode: 'SAML_2_0' })
    })
  })

  it('creates an app authored INACTIVE without activating it', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'INACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [app({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes[0].query.activate).toBe('false')
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('sends the integration name only when the canvas authored one', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [app({ signOnMode: 'OPENID_CONNECT', name: 'oidc_client' })],
        }),
      )

      expect(writeCalls(calls)[0].json.name).toBe('oidc_client')
    })
  })

  it('merges every authored blob into the create body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            app({
              settingsJson: '{"signOn":{"ssoAcsUrl":"https://acme.test/acs"}}',
              credentialsJson: '{"userNameTemplate":{"template":"${source.login}"}}',
              visibilityJson: '{"hide":{"iOS":true}}',
              accessibilityJson: '{"selfService":false}',
              profileJson: '{"owner":"secops"}',
            }),
          ],
        }),
      )

      const body = writeCalls(calls)[0].json
      expect(body.settings).toEqual({ signOn: { ssoAcsUrl: 'https://acme.test/acs' } })
      expect(body.credentials).toEqual({ userNameTemplate: { template: '${source.login}' } })
      expect(body.visibility).toEqual({ hide: { iOS: true } })
      expect(body.accessibility).toEqual({ selfService: false })
      expect(body.profile).toEqual({ owner: 'secops' })
    })
  })

  it('never lets a free-form blob override the app identity', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [app({ profileJson: '{"label":"Evil","signOnMode":"BOOKMARK"}' })],
        }),
      )

      const body = writeCalls(calls)[0].json
      expect(body.label).toBe('Salesforce')
      expect(body.signOnMode).toBe('SAML_2_0')
      expect(body.profile).toEqual({ label: 'Evil', signOnMode: 'BOOKMARK' })
    })
  })

  it('refuses a malformed blob before it makes a single request', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [app({ settingsJson: '{not json' })] }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/settings \(settingsJson\) is not a valid JSON object/)
  })

  it('records the created app so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [app()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('0oaNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['0oaNEW'])
  })

  it('captures the OIDC client secret Okta only ever returns once, on create', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({
          id: '0oaNEW',
          status: 'ACTIVE',
          credentials: { oauthClient: { client_id: '0oaCID', client_secret: 's3cr3t' } },
        }),
      ],
      async () =>
        deploy(
          deployContext({ sections: [app({ signOnMode: 'OPENID_CONNECT', name: 'oidc_client' })] }),
        ),
    )

    expect(result.success).toBe(true)
    const captured = (result.artifacts as {
      capturedCredentials: Array<{ client_id?: string; client_secret?: string }>
    }).capturedCredentials
    expect(captured).toHaveLength(1)
    expect(captured[0].client_id).toBe('0oaCID')
    expect(captured[0].client_secret).toBe('s3cr3t')
    expect(result.message).toMatch(/only once, on create/)
    // The app's own secret is an artifact by design; the ADMIN token never is.
    expect(leaksToken(result)).toBe(false)
  })

  it('fails rather than inventing an id when the create returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ label: 'Salesforce' })], async () =>
      deploy(deployContext({ sections: [app()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('full-replaces an existing app and captures its prior definition', async () => {
    const result = await withFetch([ok([LIVE_APP]), ok({})], async (calls) => {
      const res = await deploy(
        deployContext({
          sections: [app({ settingsJson: '{"signOn":{"ssoAcsUrl":"https://new.example.test"}}' })],
        }),
      )

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/apps/0oaLIVE')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('0oaLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    expect(entry.priorAccessPolicyId).toBe('rst0PRIOR')
    // Server-managed fields must never be replayed on the restoring PUT.
    expect(entry.prior).toEqual({
      label: 'Salesforce',
      name: 'salesforce_app',
      signOnMode: 'SAML_2_0',
      settings: { signOn: { ssoAcsUrl: 'https://old.example.test' } },
      visibility: { hide: { iOS: false } },
    })
  })

  it('reconciles the lifecycle separately from the update body', async () => {
    await withFetch([ok([LIVE_APP]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [app({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes[0].json.status).toBeUndefined()
      expect(writes[1].method).toBe('POST')
      expect(writes[1].path).toBe('/apps/0oaLIVE/lifecycle/deactivate')
    })
  })

  it('does not touch the lifecycle when the app is already at the desired status', async () => {
    await withFetch([ok([LIVE_APP]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [app({ status: 'ACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('associates the declared access policy after the update', async () => {
    await withFetch([ok([LIVE_APP]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [app({ accessPolicyId: 'rst0NEW' })] }))

      expect(result.success).toBe(true)
      const associate = writeCalls(calls)[1]
      expect(associate.method).toBe('PUT')
      expect(associate.path).toBe('/apps/0oaLIVE/policies/rst0NEW')
    })
  })

  it('explains the OIE requirement when the policy association is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_APP]), ok({}), apiError('Not found: Policy', 404)],
      async () => deploy(deployContext({ sections: [app({ accessPolicyId: 'rst0NEW' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to associate app 0oaLIVE with access policy rst0NEW/)
    expect(result.message).toMatch(/Okta Identity Engine/)
  })

  it('refuses an ambiguous label match rather than replacing the wrong app', async () => {
    const result = await withFetch(
      [ok([LIVE_APP, { ...LIVE_APP, id: '0oaTWIN' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [app()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Ambiguous match: 2 Okta apps/)
    expect(result.message).toMatch(/ambiguous_match/)
  })

  it('refuses to convert an app that exists under a different sign-on mode', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_APP, signOnMode: 'BOOKMARK' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [app()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/already exists with a different sign-on mode \(BOOKMARK\)/)
    expect(result.message).toMatch(/immutable/)
  })

  it('ignores a live app whose label merely starts with the declared one', async () => {
    await withFetch(
      [ok([{ ...LIVE_APP, id: '0oaOTHER', label: 'Salesforce Sandbox' }]), ok({ id: '0oaNEW', status: 'ACTIVE' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [app()] }))

        expect(result.success).toBe(true)
        // A prefix hit from ?q= is not a match — a new app is created instead.
        expect(writeCalls(calls)[0].path).toBe('/apps')
        expect(calls.some((c) => c.path === '/apps/0oaOTHER')).toBe(false)
      },
    )
  })

  it('never modifies a protected Okta system app it resolves to', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_APP, name: 'okta_admin_console' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [app()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/protected Okta system app "okta_admin_console"/)
  })

  it('never creates an app under a protected Okta system name', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [app({ name: 'saasure' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/protected Okta system app name "saasure"/)
  })

  it('returns a FAILED result rather than throwing when the app list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [app()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list apps while resolving "Salesforce"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_APP]), apiError('Api validation failed', 400, ['settings: invalid'])],
      async () => deploy(deployContext({ sections: [app()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/Failed to update app "Salesforce"/)
    expect(result.message).toMatch(/settings: invalid/)
  })

  it('reports partial progress and keeps rollback state when a later app fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({ id: '0oaONE', status: 'ACTIVE' }),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [app(), { ...app({ label: 'Workday' }), name: 'Workday section' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['0oaONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('never deletes an app during a deploy', async () => {
    await withFetch([ok([LIVE_APP]), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [app({ status: 'INACTIVE' })] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('skips a section missing a label or a sign-on mode', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [app({ label: '' }), app({ signOnMode: '' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve an app', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0oaNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [app()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
