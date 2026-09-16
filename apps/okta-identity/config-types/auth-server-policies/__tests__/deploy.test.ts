// =============================================================================
// auth-server-policies — deploy, driven against the fake Okta org.
//
// An authorization-server policy decides WHICH OAuth clients may ask this server
// for a token, and its rules decide what those tokens look like. It is a CHILD
// of an authorization server, so its identity is the (authServerId, name) pair
// and every request hangs off the parent — which means the parent failing to
// resolve is a first-class failure path. These tests assert the request
// sequence, the bodies sent, the never-delete guarantees and the rollback state.
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

function policy(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner access',
    fields: {
      authServerId: 'default',
      name: 'Partner access',
      description: 'Who may ask for a partner token',
      status: 'ACTIVE',
      clientInclude: ['0oaPARTNER'],
      ...fields,
    },
  }
}

const LIVE_POLICY = {
  id: '00pLIVE',
  type: 'OAUTH_AUTHORIZATION_POLICY',
  name: 'Partner access',
  description: 'Old description',
  status: 'ACTIVE',
  priority: 1,
  system: false,
  conditions: { clients: { include: ['ALL_CLIENTS'] } },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com' } },
}

const POLICIES_PATH = '/authorizationServers/default/policies'

describe('auth-server-policies deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [policy()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [policy()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('scopes every request to the declared parent authorization server', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy({ authServerId: 'aus1a2b3c' })] }))

      for (const call of calls) {
        expect(call.path.startsWith('/authorizationServers/aus1a2b3c/policies')).toBe(true)
      }
    })
  })

  it('url-encodes a parent id so it can never escape its own collection path', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy({ authServerId: 'aus/../default' })] }))

      expect(calls[0].path).toBe('/authorizationServers/aus%2F..%2Fdefault/policies')
    })
  })

  it('fails with the parent named when the authorization server cannot be resolved', async () => {
    const result = await withFetch([notFound('Not found: authorizationServer')], async (calls) => {
      const res = await deploy(deployContext({ sections: [policy({ authServerId: 'ausGONE' })] }))
      // A parent that does not resolve must never be turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list policies for authorization server "ausGONE"/)
    expect(result.message).toMatch(/ausGONE:Partner access/)
  })

  it('creates a policy that does not exist and sends the modelled body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy({ priority: 3 })] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(POLICIES_PATH)

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe(POLICIES_PATH)
      expect(writes[0].json).toEqual({
        type: 'OAUTH_AUTHORIZATION_POLICY',
        name: 'Partner access',
        status: 'ACTIVE',
        description: 'Who may ask for a partner token',
        conditions: { clients: { include: ['0oaPARTNER'] } },
        priority: 3,
      })
    })
  })

  it('defaults the client scoping to ALL_CLIENTS when none is authored', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy({ clientInclude: [] })] }))

      expect(writeCalls(calls)[0].json.conditions).toEqual({
        clients: { include: ['ALL_CLIENTS'] },
      })
    })
  })

  it('omits priority entirely when the canvas leaves it blank', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy({ priority: '' })] }))

      const body = writeCalls(calls)[0].json
      expect(Object.prototype.hasOwnProperty.call(body, 'priority')).toBe(false)
    })
  })

  it('records the created policy in rollback state so rollback can remove it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })],
      async () => deploy(deployContext({ sections: [policy()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdPolicyIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('00pNEW')
    expect(rb.previousState[0].authServerId).toBe('default')
    expect(rb.previousState[0].priorPolicy).toBeUndefined()
    expect(rb.previousState[0].rules).toEqual([])
    expect(rb.createdPolicyIds).toEqual(['00pNEW'])
  })

  it('fails when the create returns no id rather than recording an unrollbackable policy', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [policy()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdPolicyIds: string[] }).createdPolicyIds).toEqual([])
  })

  it('updates a matched policy in place and captures its full prior body and status', async () => {
    const result = await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [policy()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe(`${POLICIES_PATH}/00pLIVE`)
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('00pLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    expect(entry.priorPolicy).toEqual(LIVE_POLICY)
  })

  it('matches the policy name only within its own parent authorization server', async () => {
    await withFetch(
      [ok([{ ...LIVE_POLICY, name: 'Something else' }]), ok({ id: '00pNEW', status: 'ACTIVE' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [policy()] }))

        expect(result.success).toBe(true)
        // No same-named policy under THIS parent, so it is created, not adopted.
        expect(writeCalls(calls)[0].method).toBe('POST')
      },
    )
  })

  it('updates the built-in system Default Policy in place and never deletes it', async () => {
    await withFetch(
      [ok([{ ...LIVE_POLICY, id: '00pSYS', name: 'Default Policy', system: true }]), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({ sections: [policy({ name: 'Default Policy' })] }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        expect(writeCalls(calls)[0].method).toBe('PUT')
        expect(writeCalls(calls)[0].path).toBe(`${POLICIES_PATH}/00pSYS`)
      },
    )
  })

  it('moves an existing policy to the desired status through the lifecycle endpoint', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[1].path).toBe(`${POLICIES_PATH}/00pLIVE/lifecycle/deactivate`)
      expect(writes[1].method).toBe('POST')
    })
  })

  it('treats a 404 on the policy lifecycle transition as already in that state', async () => {
    const result = await withFetch([ok([LIVE_POLICY]), ok({}), notFound()], async () =>
      deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(true)
  })

  it('returns a FAILED result when the policy lifecycle transition is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate authorization-server policy "default:Partner access"/)
  })

  it('refuses malformed rules JSON before making a single request', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [policy({ rulesJson: '{"name":"not an array"}' })] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON array/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses a rule with no name before making a single request', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [policy({ rulesJson: '[{"actions":{}}]' })] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/rule at index 0 has no "name"/)
      expect(calls).toHaveLength(0)
    })
  })

  it('creates a missing rule, forcing RESOURCE_ACCESS and keeping status out of the body', async () => {
    await withFetch(
      [
        ok([LIVE_POLICY]),
        ok({}),
        EMPTY_LIST,
        ok({ id: '0prNEW', status: 'ACTIVE' }),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [
              policy({
                rulesJson: JSON.stringify([
                  {
                    name: 'Short-lived tokens',
                    type: 'ACCESS_POLICY_RULE',
                    status: 'INACTIVE',
                    id: '0prSHOULD_BE_STRIPPED',
                    actions: { token: { accessTokenLifetimeMinutes: 60 } },
                  },
                ]),
              }),
            ],
          }),
        )

        expect(result.success).toBe(true)
        const rulesPath = `${POLICIES_PATH}/00pLIVE/rules`
        expect(calls[2].method).toBe('GET')
        expect(calls[2].path).toBe(rulesPath)

        const create = writeCalls(calls)[1]
        expect(create.method).toBe('POST')
        expect(create.path).toBe(rulesPath)
        expect(create.json).toEqual({
          name: 'Short-lived tokens',
          actions: { token: { accessTokenLifetimeMinutes: 60 } },
          type: 'RESOURCE_ACCESS',
        })

        // status is driven by the lifecycle endpoint, never the body.
        const lifecycle = writeCalls(calls)[2]
        expect(lifecycle.path).toBe(`${rulesPath}/0prNEW/lifecycle/deactivate`)
      },
    )
  })

  it('replaces a same-named rule in place — including a system rule — and never deletes it', async () => {
    await withFetch(
      [
        ok([LIVE_POLICY]),
        ok({}),
        ok([{ id: '0prSYS', name: 'Default Rule', status: 'ACTIVE', system: true }]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Default Rule', actions: {} }]) })],
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        const put = writeCalls(calls)[1]
        expect(put.method).toBe('PUT')
        expect(put.path).toBe(`${POLICIES_PATH}/00pLIVE/rules/0prSYS`)
      },
    )
  })

  it('never prunes a live rule the canvas does not mention', async () => {
    await withFetch(
      [
        ok([LIVE_POLICY]),
        ok({}),
        ok([{ id: '0prSYS', name: 'Default Rule', status: 'ACTIVE', system: true }]),
        ok({ id: '0prNEW', status: 'ACTIVE' }),
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Extra rule', actions: {} }]) })],
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        expect(calls.some((c) => c.path.includes('0prSYS'))).toBe(false)
      },
    )
  })

  it('records prior rule state so rollback can revert an updated rule', async () => {
    const liveRule = {
      id: '0prSYS',
      name: 'Default Rule',
      type: 'RESOURCE_ACCESS',
      status: 'INACTIVE',
      system: true,
      actions: { token: { accessTokenLifetimeMinutes: 30 } },
    }
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), ok([liveRule]), ok({}), ok({})],
      async () =>
        deploy(
          deployContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Default Rule', actions: {} }]) })],
          }),
        ),
    )

    expect(result.success).toBe(true)
    const entry = (
      result.rollbackData as { previousState: Array<{ rules: Array<Record<string, unknown>> }> }
    ).previousState[0]
    expect(entry.rules).toHaveLength(1)
    expect(entry.rules[0].id).toBe('0prSYS')
    expect(entry.rules[0].existed).toBe(true)
    expect(entry.rules[0].priorStatus).toBe('INACTIVE')
    expect(entry.rules[0].prior).toEqual(liveRule)
  })

  it('skips rule reconciliation entirely when no rules are authored', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/rules'))).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the rule list is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Extra rule' }]) })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list rules for authorization-server policy 00pLIVE/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the policy update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), apiError('Api validation failed: conditions', 400, ['clients: unknown'])],
      async () => deploy(deployContext({ sections: [policy()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update authorization-server policy "default:Partner access"/)
    expect(result.message).toMatch(/clients: unknown/)
  })

  it('does not depend on the platform data API to resolve a policy', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '00pNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [policy()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [policy({ authServerId: '' }), policy({ name: '' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports partial progress and keeps rollback state when a later policy fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({ id: '00pONE', status: 'ACTIVE' }),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [
              policy(),
              { name: 'Second', fields: { authServerId: 'default', name: 'Second policy' } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdPolicyIds: string[] }
    expect(rb.createdPolicyIds).toEqual(['00pONE'])
    expect(rb.previousState).toHaveLength(1)
    expect((result.artifacts as { deployedPolicies: string[] }).deployedPolicies).toEqual([
      'default:Partner access',
    ])
  })

  it('never issues a DELETE — deploy only ever creates or replaces', async () => {
    await withFetch(
      [ok([LIVE_POLICY]), ok({}), EMPTY_LIST, ok({ id: '0prNEW', status: 'ACTIVE' })],
      async (calls) => {
        await deploy(
          deployContext({
            sections: [policy({ rulesJson: JSON.stringify([{ name: 'Extra rule' }]) })],
          }),
        )
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      },
    )
  })
})
