// =============================================================================
// idps — deploy, driven against the fake Okta org.
//
// An identity provider IS federated sign-in. A broken protocol or policy locks
// every federated user out; a duplicate IdP quietly routes some of them
// somewhere else. Okta has no upsert, status is only movable through the
// lifecycle endpoints, and the OAuth client secret is write-only — it goes to
// Okta and must never come back out in a result. These tests assert that.
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

const PROTOCOL_JSON =
  '{"type":"OIDC","endpoints":{"authorization":{"url":"https://partner.test/auth"}},"scopes":["openid"],"credentials":{"client":{"client_id":"cid-1","client_secret":"super-secret-value"}}}'
const POLICY_JSON =
  '{"provisioning":{"action":"AUTO"},"subject":{"matchType":"USERNAME","userNameTemplate":{"template":"idpuser.email"}}}'

function idp(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner OIDC',
    fields: {
      type: 'OIDC',
      name: 'Partner OIDC',
      status: 'ACTIVE',
      protocolJson: PROTOCOL_JSON,
      policyJson: POLICY_JSON,
      ...fields,
    },
  }
}

const LIVE_IDP = {
  id: 'idp-1',
  name: 'Partner OIDC',
  type: 'OIDC',
  status: 'ACTIVE',
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://example.test' } },
  protocol: {
    type: 'OIDC',
    endpoints: { authorization: { url: 'https://partner.test/auth' } },
    scopes: ['openid'],
    credentials: { client: { client_id: 'cid-1' } },
  },
  policy: { provisioning: { action: 'AUTO' } },
}

describe('idps deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [idp()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates an IdP the org does not have, sending the authored protocol and policy', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/idps')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/idps')
      expect(writes[0].json).toEqual({
        type: 'OIDC',
        name: 'Partner OIDC',
        protocol: JSON.parse(PROTOCOL_JSON),
        policy: JSON.parse(POLICY_JSON),
      })
      // status is NEVER part of the body — it moves through the lifecycle.
      expect(writes[0].json.status).toBeUndefined()
    })
  })

  it('writes the client secret to Okta but never back into the result', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [idp()] }))
        expect(calls[1].body).toMatch('super-secret-value')
        return res
      },
    )

    expect(result.success).toBe(true)
    expect(JSON.stringify(result).includes('super-secret-value')).toBe(false)
  })

  it('records the created IdP so rollback can delete it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })],
      async () => deploy(deployContext({ sections: [idp()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.createdIds).toEqual(['idp-NEW'])
    expect(rb.previousState).toEqual([{ name: 'Partner OIDC', existed: false, id: 'idp-NEW' }])
  })

  it('updates an IdP that already exists and captures its prior definition', async () => {
    const result = await withFetch([ok([LIVE_IDP]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [idp()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/idps/idp-1')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('idp-1')
    expect(entry.priorStatus).toBe('ACTIVE')
    // Server-managed fields are stripped so the body is safe to PUT back.
    expect(entry.prior).toEqual({
      name: 'Partner OIDC',
      type: 'OIDC',
      protocol: LIVE_IDP.protocol,
      policy: LIVE_IDP.policy,
    })
  })

  it('lets the modelled type and name win over anything inside the protocol JSON', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            idp({ protocolJson: '{"type":"SAML2","name":"Impostor","scopes":["openid"]}' }),
          ],
        }),
      )

      const body = writeCalls(calls)[0].json
      expect(body.type).toBe('OIDC')
      expect(body.name).toBe('Partner OIDC')
    })
  })

  it('matches an IdP by exact name and never adopts a differently named one', async () => {
    await withFetch(
      [ok([{ ...LIVE_IDP, id: 'idp-OTHER', name: 'partner oidc' }]), ok({ id: 'idp-NEW' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [idp()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[0].method).toBe('POST')
        expect(calls.some((c) => c.path === '/idps/idp-OTHER')).toBe(false)
      },
    )
  })

  it('follows pagination when the IdP list spans pages', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'idp-x', name: 'Another', type: 'SAML2' }],
          headers: { link: `<${API_BASE}/idps?after=abc>; rel="next"` },
        },
        ok([LIVE_IDP]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [idp()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('abc')
        expect(writeCalls(calls)[0].path).toBe('/idps/idp-1')
      },
    )
  })

  it('omits the policy from the body when the canvas declares none', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp({ policyJson: '' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.policy).toBeUndefined()
    })
  })

  it('returns a FAILED result rather than throwing when the protocol JSON is unusable', async () => {
    for (const protocolJson of ['', 'not json', '[1,2,3]']) {
      const result = await withFetch([], async (calls) => {
        const res = await deploy(deployContext({ sections: [idp({ protocolJson })] }))
        // It fails BEFORE any request — a malformed protocol never reaches Okta.
        expect(calls).toHaveLength(0)
        return res
      })

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/protocol \(protocolJson\) is not a valid JSON object/)
    }
  })

  it('returns a FAILED result rather than throwing when the policy JSON is unusable', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [idp({ policyJson: '[1,2]' })] }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/policy \(policyJson\) is not a valid JSON object/)
  })

  it('deactivates a newly created IdP that should not be live yet', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/idps/idp-NEW/lifecycle/deactivate')).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-activates an IdP an admin had turned off', async () => {
    await withFetch([ok([{ ...LIVE_IDP, status: 'INACTIVE' }]), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [idp()] }))
      expect(writeCalls(calls)[1].path).toBe('/idps/idp-1/lifecycle/activate')
    })
  })

  it('leaves the lifecycle alone when the IdP is already in the desired status', async () => {
    await withFetch([ok([LIVE_IDP]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [idp()] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('treats a 404 on the lifecycle transition as already-in-that-state', async () => {
    await withFetch([ok([LIVE_IDP]), ok({}), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [idp({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('fails the deploy when the lifecycle transition is rejected outright', async () => {
    const result = await withFetch(
      [ok([LIVE_IDP]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [idp({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate IdP idp-1/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [idp()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list IdPs while resolving "Partner OIDC"/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_IDP]), apiError('Api validation failed: protocol', 400, ['endpoints: required'])],
      async () => deploy(deployContext({ sections: [idp()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update IdP "Partner OIDC"/)
    expect(result.message).toMatch(/endpoints: required/)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: name', 400)],
      async () => deploy(deployContext({ sections: [idp()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create IdP "Partner OIDC"/)
  })

  it('fails loudly when a create succeeds but the API returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [idp()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('reports partial progress and keeps rollback state when a later IdP fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'idp-ONE', status: 'ACTIVE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(deployContext({ sections: [idp(), idp({ name: 'Second IdP' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['idp-ONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('does not depend on the platform handing back a prior deployment', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp()], platformThrows: true }))
      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/idps')
    })
  })

  it('ignores a section with no name or type', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('normalises a lower-case type so it still deploys as the Okta enum', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'idp-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [idp({ type: 'oidc' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.type).toBe('OIDC')
    })
  })
})
