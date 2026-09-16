// =============================================================================
// authorization-servers — deploy, driven against the fake Okta org.
//
// A custom authorization server is the thing that MINTS access tokens: its
// audiences decide who a token is valid for and its lifecycle decides whether it
// issues at all. There is no upsert, so deploy has to list, match by name and
// then PUT or POST — and the Okta-provided `default` server may only ever be
// updated in place. These tests assert the request sequence, the bodies sent,
// the failure contract and the rollback state recorded.
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

function server(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner API',
    fields: {
      name: 'Partner API',
      description: 'Tokens for the partner integration',
      audiences: ['api://partner'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const LIVE_SERVER = {
  id: 'aus1a2b3c',
  name: 'Partner API',
  description: 'Old description',
  audiences: ['api://old'],
  issuerMode: 'ORG_URL',
  status: 'ACTIVE',
  issuer: 'https://dev-12345.okta.com/oauth2/aus1a2b3c',
  credentials: { signing: { rotationMode: 'AUTO' } },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com' } },
}

describe('authorization-servers deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [server()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [server()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [server()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [server()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a server that does not exist and sends only the modelled fields', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [server({ issuerMode: 'CUSTOM_URL' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/authorizationServers')
      expect(calls[0].method).toBe('GET')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/authorizationServers')
      expect(writes[0].json).toEqual({
        name: 'Partner API',
        description: 'Tokens for the partner integration',
        audiences: ['api://partner'],
        issuerMode: 'CUSTOM_URL',
      })
    })
  })

  it('never sends the server-managed issuer, credentials or status in the create body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [server()] }))

      const body = writeCalls(calls)[0].json
      expect(body.issuer).toBeUndefined()
      expect(body.credentials).toBeUndefined()
      expect(body.status).toBeUndefined()
      expect(body.id).toBeUndefined()
    })
  })

  it('records the created server in rollback state so rollback can remove it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })],
      async () => deploy(deployContext({ sections: [server()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('ausNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['ausNEW'])
  })

  it('fails when the create returns no id rather than recording an unrollbackable server', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [server()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('deactivates a freshly created server when INACTIVE was authored', async () => {
    await withFetch(
      [EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({ sections: [server({ status: 'INACTIVE' })] }),
        )

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[1].path).toBe('/authorizationServers/ausNEW/lifecycle/deactivate')
        expect(writes[1].method).toBe('POST')
      },
    )
  })

  it('updates a matched server in place and captures its prior body and status', async () => {
    const result = await withFetch([ok([LIVE_SERVER]), ok(LIVE_SERVER)], async (calls) => {
      const res = await deploy(deployContext({ sections: [server()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/authorizationServers/aus1a2b3c')
      expect(writes[0].json.audiences).toEqual(['api://partner'])
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('aus1a2b3c')
    expect(entry.priorStatus).toBe('ACTIVE')
    // The captured prior is safe to PUT back: every server-managed readOnly
    // field has been stripped.
    expect(entry.prior).toEqual({
      name: 'Partner API',
      description: 'Old description',
      audiences: ['api://old'],
      issuerMode: 'ORG_URL',
    })
  })

  it('clears a description the canvas no longer sets rather than leaving it stale', async () => {
    await withFetch([ok([LIVE_SERVER]), ok(LIVE_SERVER)], async (calls) => {
      await deploy(deployContext({ sections: [server({ description: '' })] }))

      expect(writeCalls(calls)[0].json.description).toBe('')
    })
  })

  it('omits issuerMode entirely when the canvas does not author it', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [server()] }))

      const body = writeCalls(calls)[0].json
      expect(Object.prototype.hasOwnProperty.call(body, 'issuerMode')).toBe(false)
    })
  })

  it('updates the Okta-provided default server in place and never deletes it', async () => {
    await withFetch(
      [ok([{ ...LIVE_SERVER, id: 'default', name: 'default' }]), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [server({ name: 'default', audiences: ['api://default'] })],
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(1)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/authorizationServers/default')
      },
    )
  })

  it('follows the rel="next" Link header so a server on a later page still matches', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'ausOTHER', name: 'Something else', status: 'ACTIVE' }],
          headers: {
            link: `<${API_BASE}/authorizationServers?after=ausOTHER>; rel="next"`,
          },
        },
        ok([LIVE_SERVER]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [server()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('ausOTHER')
        // Matched on page two — updated, not created a second time.
        const writes = writeCalls(calls)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/authorizationServers/aus1a2b3c')
      },
    )
  })

  it('does not depend on the platform data API to resolve a server', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ausNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(
        deployContext({ sections: [server()], platformThrows: true }),
      )
      expect(result.success).toBe(true)
    })
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            server({ name: '' }),
            server({ audiences: ['api://one', 'api://two'] }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the list itself is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [server()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create — that would mint a second authorization server.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_SERVER]), apiError('Api validation failed: audiences', 400, ['audiences: invalid'])],
      async () => deploy(deployContext({ sections: [server()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update authorization server "Partner API"/)
    expect(result.message).toMatch(/audiences: invalid/)
  })

  it('returns a FAILED result when the lifecycle transition is rejected', async () => {
    const result = await withFetch(
      [
        ok([{ ...LIVE_SERVER, status: 'INACTIVE' }]),
        ok({}),
        apiError('Insufficient permissions', 403),
      ],
      async () => deploy(deployContext({ sections: [server({ status: 'ACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to activate authorization server aus1a2b3c/)
  })

  it('treats a 404 on the lifecycle transition as already in that state', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_SERVER, status: 'INACTIVE' }]), ok({}), { status: 404, body: {} }],
      async () => deploy(deployContext({ sections: [server({ status: 'ACTIVE' })] })),
    )

    expect(result.success).toBe(true)
  })

  it('reports partial progress and keeps rollback state when a later server fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({ id: 'ausONE', status: 'ACTIVE' }),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [
              server(),
              { name: 'Second', fields: { name: 'Second API', audiences: ['api://second'], status: 'ACTIVE' } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['ausONE'])
    // The first server WAS created — rollback must still be able to undo it.
    expect(rb.previousState).toHaveLength(1)
    expect((result.artifacts as { deployedAuthServers: string[] }).deployedAuthServers).toEqual([
      'Partner API',
    ])
  })

  it('never issues a DELETE — deploy only ever creates or updates', async () => {
    await withFetch([ok([LIVE_SERVER]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [server()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })
})
