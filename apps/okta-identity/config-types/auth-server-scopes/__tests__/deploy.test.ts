// =============================================================================
// auth-server-scopes — deploy, driven against the fake Okta org.
//
// A scope is the unit of authority inside an access token: `consent` decides
// whether the user is ever asked, `default` decides whether it is granted when
// nothing was requested, and `metadataPublish` decides whether the world can
// discover it. Scopes are CHILDREN of an authorization server, so the parent
// failing to resolve is a first-class failure path, and Okta's own system scopes
// must never be touched. These tests assert the requests, the bodies, the
// skip/never-touch guarantees and the rollback state.
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
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function scope(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'partner.read',
    fields: {
      authServerId: 'default',
      name: 'partner.read',
      displayName: 'Read partner data',
      description: 'Grants read access to the partner API',
      consent: 'REQUIRED',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
      ...fields,
    },
  }
}

const LIVE_SCOPE = {
  id: 'scpLIVE',
  name: 'partner.read',
  displayName: 'Old display name',
  description: 'Old description',
  consent: 'IMPLICIT',
  default: true,
  metadataPublish: 'ALL_CLIENTS',
  optional: true,
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com' } },
}

const SCOPES_PATH = '/authorizationServers/default/scopes'

describe('auth-server-scopes deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [scope()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [scope()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [scope()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [scope()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('scopes every request to the declared parent authorization server', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [scope({ authServerId: 'aus1a2b3c' })] }))

      for (const call of calls) {
        expect(call.path.startsWith('/authorizationServers/aus1a2b3c/scopes')).toBe(true)
      }
    })
  })

  it('fails with the parent named when the authorization server cannot be resolved', async () => {
    const result = await withFetch([notFound('Not found: authorizationServer')], async (calls) => {
      const res = await deploy(deployContext({ sections: [scope({ authServerId: 'ausGONE' })] }))
      // A parent that does not resolve must never be turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list scopes on authorization server "ausGONE"/)
    expect(result.message).toMatch(/0 of 1/)
  })

  it('creates a scope that does not exist and sends the modelled body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [scope()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(SCOPES_PATH)

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe(SCOPES_PATH)
      expect(writes[0].json).toEqual({
        name: 'partner.read',
        consent: 'REQUIRED',
        default: false,
        metadataPublish: 'NO_CLIENTS',
        optional: false,
        displayName: 'Read partner data',
        description: 'Grants read access to the partner API',
      })
    })
  })

  it('never sends a server-managed field in the create body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [scope()] }))

      const body = writeCalls(calls)[0].json
      expect(body.id).toBeUndefined()
      expect(body.system).toBeUndefined()
      expect(body.created).toBeUndefined()
    })
  })

  it('defaults consent to IMPLICIT and metadataPublish to NO_CLIENTS when unauthored', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      await deploy(
        deployContext({ sections: [scope({ consent: '', metadataPublish: '', displayName: '', description: '' })] }),
      )

      expect(writeCalls(calls)[0].json).toEqual({
        name: 'partner.read',
        consent: 'IMPLICIT',
        default: false,
        metadataPublish: 'NO_CLIENTS',
        optional: false,
      })
    })
  })

  it('reads a checkbox that arrives as a string rather than silently sending false', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [scope({ default: 'true', optional: 'yes' })] }))

      const body = writeCalls(calls)[0].json
      expect(body.default).toBe(true)
      expect(body.optional).toBe(true)
    })
  })

  it('records the created scope in rollback state so rollback can remove it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async () =>
      deploy(deployContext({ sections: [scope()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('scpNEW')
    expect(rb.previousState[0].authServerId).toBe('default')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['scpNEW'])
  })

  it('fails when the create returns no id rather than recording an unrollbackable scope', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'partner.read' })], async () =>
      deploy(deployContext({ sections: [scope()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a matched scope in place and captures its prior body', async () => {
    const result = await withFetch([ok([LIVE_SCOPE]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [scope()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe(`${SCOPES_PATH}/scpLIVE`)
      expect(writes[0].json.consent).toBe('REQUIRED')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('scpLIVE')
    // The captured prior is safe to PUT back: every server-managed field is gone.
    expect(entry.prior).toEqual({
      name: 'partner.read',
      displayName: 'Old display name',
      description: 'Old description',
      consent: 'IMPLICIT',
      default: true,
      metadataPublish: 'ALL_CLIENTS',
      optional: true,
    })
  })

  it('matches the scope name case-sensitively within its own parent server', async () => {
    await withFetch([ok([{ ...LIVE_SCOPE, name: 'Partner.Read' }]), ok({ id: 'scpNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [scope()] }))

      expect(result.success).toBe(true)
      // A differently-cased scope is a DIFFERENT scope — created, not adopted.
      expect(writeCalls(calls)[0].method).toBe('POST')
    })
  })

  it('leaves a live built-in system scope completely untouched', async () => {
    await withFetch([ok([{ ...LIVE_SCOPE, system: true }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [scope()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
      expect(result.message).toMatch(/built-in system scope — left untouched/)
      expect((result.artifacts as { skippedScopes: string[] }).skippedScopes).toHaveLength(1)
      // Nothing to undo — a skipped scope is never recorded for rollback.
      expect((result.rollbackData as { previousState: unknown[] }).previousState).toHaveLength(0)
    })
  })

  it('refuses to create a reserved Okta system scope even if it is absent', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [scope({ name: 'openid' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/reserved Okta system scope/)
  })

  it('refuses a reserved scope name case-insensitively', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      deploy(deployContext({ sections: [scope({ name: 'Offline_Access' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/reserved Okta system scope/)
  })

  it('follows the rel="next" Link header so a scope on a later page still matches', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'scpOTHER', name: 'other.scope' }],
          headers: { link: `<${API_BASE}${SCOPES_PATH}?after=scpOTHER>; rel="next"` },
        },
        ok([LIVE_SCOPE]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [scope()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('scpOTHER')
        expect(writeCalls(calls)[0].method).toBe('PUT')
        expect(writeCalls(calls)[0].path).toBe(`${SCOPES_PATH}/scpLIVE`)
      },
    )
  })

  it('does not depend on the platform data API to resolve a scope', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'scpNEW' })], async () => {
      const result = await deploy(deployContext({ sections: [scope()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [scope({ authServerId: '' }), scope({ name: '' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the list itself is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [scope()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create — that would mint a second grant of the same authority.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_SCOPE]), apiError('Api validation failed: consent', 400, ['consent: invalid'])],
      async () => deploy(deployContext({ sections: [scope()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update scope "default:partner.read"/)
    expect(result.message).toMatch(/consent: invalid/)
  })

  it('reports partial progress and keeps rollback state when a later scope fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'scpONE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              scope(),
              { name: 'Second', fields: { authServerId: 'default', name: 'partner.write' } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['scpONE'])
    expect(rb.previousState).toHaveLength(1)
    expect((result.artifacts as { deployedScopes: string[] }).deployedScopes).toEqual([
      'default:partner.read',
    ])
  })

  it('never issues a DELETE — deploy only ever creates or updates', async () => {
    await withFetch([ok([LIVE_SCOPE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [scope()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })
})
