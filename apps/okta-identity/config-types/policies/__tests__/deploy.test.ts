// =============================================================================
// policies — deploy, driven against the fake Okta org.
//
// A policy is the door: sign-on, password and MFA-enrolment rules decide who
// gets in and how hard it is. Deploying one wrong is a lockout or an open door,
// and Okta has no upsert — the handler has to find, replace or create, then move
// the lifecycle separately. The tests below assert the request sequence, the
// exact bodies sent, the rollback state recorded and the failure contract.
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
  priorDeployment,
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

const LIVE_POLICY = {
  id: 'pol-1',
  type: 'OKTA_SIGN_ON',
  name: 'Corporate sign-on',
  description: 'Sign-on policy for staff',
  status: 'ACTIVE',
  system: false,
  priority: 1,
  conditions: {},
}

describe('policies deploy', () => {
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
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('looks the policy up by type and creates it when the org has none by that name', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/policies')
      expect(calls[0].query.type).toBe('OKTA_SIGN_ON')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/policies')
      expect(writes[0].json).toEqual({
        type: 'OKTA_SIGN_ON',
        name: 'Corporate sign-on',
        status: 'ACTIVE',
        description: 'Sign-on policy for staff',
      })
    })
  })

  it('records the created policy so rollback can delete it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })],
      async () => deploy(deployContext({ sections: [policy()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdPolicyIds: string[]
      resourceIds: Record<string, string>
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0]).toEqual({
      type: 'OKTA_SIGN_ON',
      name: 'Corporate sign-on',
      existed: false,
      rules: [],
      id: 'pol-NEW',
    })
    expect(rb.createdPolicyIds).toEqual(['pol-NEW'])
    expect(rb.resourceIds).toEqual({ 'item-1': 'pol-NEW' })
  })

  it('REPLACES a policy that already exists and captures its prior body and status', async () => {
    const result = await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [policy()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/policies/pol-1')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('pol-1')
    expect(entry.priorPolicy).toEqual(LIVE_POLICY)
    expect(entry.priorStatus).toBe('ACTIVE')
  })

  it('matches the policy NAME exactly so a same-named policy of another type is never adopted', async () => {
    await withFetch(
      [ok([{ ...LIVE_POLICY, id: 'pol-OTHER', name: 'Corporate sign-on ' }]), ok({ id: 'pol-NEW' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [policy()] }))

        expect(result.success).toBe(true)
        // The trailing-space name is a different policy — create, not adopt.
        expect(writeCalls(calls)[0].path).toBe('/policies')
        expect(calls.some((c) => c.path === '/policies/pol-OTHER')).toBe(false)
      },
    )
  })

  it('follows pagination when the org has more policies than one page', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ ...LIVE_POLICY, id: 'pol-page1', name: 'Something else' }],
          headers: { link: `<${API_BASE}/policies?type=OKTA_SIGN_ON&after=abc>; rel="next"` },
        },
        ok([LIVE_POLICY]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [policy()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('abc')
        // Found on page two — replaced, not duplicated.
        expect(writeCalls(calls)[0].path).toBe('/policies/pol-1')
      },
    )
  })

  it('always sends description, so clearing it on the canvas converges the policy', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [policy({ description: '' })] }))
      expect(writeCalls(calls)[0].json.description).toBe('')
    })
  })

  it('turns scoped group ids into the people.groups.include condition', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy({ groupIncludeIds: ['grp-1', 'grp-2'] })] }))

      expect(writeCalls(calls)[0].json.conditions).toEqual({
        people: { groups: { include: ['grp-1', 'grp-2'] } },
      })
    })
  })

  it('omits conditions entirely when the policy applies to all users', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [policy()] }))
      expect(writeCalls(calls)[0].json.conditions).toBeUndefined()
    })
  })

  it('sends the parsed settings for a PASSWORD policy', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            policy(
              {
                type: 'PASSWORD',
                settingsJson: '{"password":{"complexity":{"minLength":12}}}',
              },
              'Strong passwords',
            ),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].query.type).toBe('PASSWORD')
      expect(writeCalls(calls)[0].json.settings).toEqual({
        password: { complexity: { minLength: 12 } },
      })
    })
  })

  it('never sends settings for OKTA_SIGN_ON even when the canvas authored some', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [policy({ settingsJson: '{"ignored":true}' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.settings).toBeUndefined()
    })
  })

  it('returns a FAILED result rather than throwing when the settings JSON is not an object', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(
        deployContext({
          sections: [policy({ type: 'PASSWORD', settingsJson: '[1,2,3]' }, 'Strong passwords')],
        }),
      )
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/not a valid JSON object/)
  })

  it('moves an existing policy to the desired status through the lifecycle endpoint, not the body', async () => {
    await withFetch(
      [ok([{ ...LIVE_POLICY, status: 'ACTIVE' }]), ok({}), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[1].method).toBe('POST')
        expect(writes[1].path).toBe('/policies/pol-1/lifecycle/deactivate')
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      },
    )
  })

  it('leaves the lifecycle alone when the policy is already in the desired status', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('activates a freshly created policy whose create response reported no status', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/policies/pol-NEW/lifecycle/activate')).toBe(true)
    })
  })

  it('treats a 404 on the lifecycle transition as already-in-that-state', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({}), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('fails the deploy when the lifecycle transition is rejected outright', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [policy({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate policy/)
    expect(leaksToken(result)).toBe(false)
  })

  it('matches by the id stored on the last successful deploy so a rename updates in place', async () => {
    await withFetch(
      [ok({ id: 'pol-STORED', type: 'OKTA_SIGN_ON', name: 'Old name', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [policy({ name: 'Renamed sign-on' }, 'Renamed sign-on')],
            latestDeployment: priorDeployment({ 'item-1': 'pol-STORED' }),
          }),
        )

        expect(result.success).toBe(true)
        // FIRST lookup is by stored id — otherwise a rename creates a duplicate
        // policy and the old one is silently left enforcing.
        expect(calls[0].path).toBe('/policies/pol-STORED')
        expect(calls.some((c) => c.path === '/policies' && c.method === 'GET')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/policies/pol-STORED')
        expect(writeCalls(calls)[0].json.name).toBe('Renamed sign-on')
      },
    )
  })

  it('falls back to (type, name) when the stored id no longer resolves', async () => {
    await withFetch([notFound(), ok([LIVE_POLICY]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [policy()],
          latestDeployment: priorDeployment({ 'item-1': 'pol-GONE' }),
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/policies/pol-GONE')
      expect(calls[1].path).toBe('/policies')
      expect(writeCalls(calls)[0].path).toBe('/policies/pol-1')
    })
  })

  it('refuses to adopt a stored id that now points at a policy of another type', async () => {
    await withFetch(
      [ok({ id: 'pol-STORED', type: 'PASSWORD', name: 'Repurposed', status: 'ACTIVE' }), ok([LIVE_POLICY]), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [policy()],
            latestDeployment: priorDeployment({ 'item-1': 'pol-STORED' }),
          }),
        )

        expect(result.success).toBe(true)
        expect(calls[1].path).toBe('/policies')
        expect(writeCalls(calls)[0].path).toBe('/policies/pol-1')
      },
    )
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'pol-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [policy()], platformThrows: true }))
      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/policies')
    })
  })

  it('returns a FAILED result rather than throwing when the lookup list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [policy()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list OKTA_SIGN_ON policies/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the replace is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), apiError('Api validation failed: conditions', 400, ['groups: not found'])],
      async () => deploy(deployContext({ sections: [policy()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update policy/)
    expect(result.message).toMatch(/groups: not found/)
  })

  it('fails loudly when a create succeeds but the API returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [policy()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('reports partial progress and keeps rollback state when a later policy fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({ id: 'pol-ONE', status: 'ACTIVE' }),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [policy(), policy({ name: 'Contractor sign-on' }, 'Contractor sign-on')],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdPolicyIds: string[] }
    expect(rb.createdPolicyIds).toEqual(['pol-ONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('carries the prior id map forward on failure so a retry stays rename-safe', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      deploy(
        deployContext({
          sections: [policy()],
          latestDeployment: priorDeployment({ 'item-1': 'pol-STORED', 'item-9': 'pol-OTHER' }),
        }),
      ),
    )

    expect(result.success).toBe(false)
    const rb = result.rollbackData as { resourceIds: Record<string, string> }
    expect(rb.resourceIds).toEqual({ 'item-1': 'pol-STORED', 'item-9': 'pol-OTHER' })
  })

  it('replaces a same-named live rule in place and records its prior body', async () => {
    const liveRule = { id: 'rul-1', name: 'Require MFA', type: 'SIGN_ON', system: false }
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), ok([liveRule]), ok({})],
      async (calls) => {
        const res = await deploy(
          deployContext({
            sections: [
              policy({ rulesJson: '[{"name":"Require MFA","type":"SIGN_ON","actions":{"signon":{"access":"ALLOW"}}}]' }),
            ],
          }),
        )

        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[1].method).toBe('PUT')
        expect(writes[1].path).toBe('/policies/pol-1/rules/rul-1')
        expect(writes[1].json).toEqual({
          name: 'Require MFA',
          type: 'SIGN_ON',
          actions: { signon: { access: 'ALLOW' } },
        })
        return res
      },
    )

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<{ rules: unknown[] }> })
      .previousState[0]
    expect(entry.rules).toEqual([
      { id: 'rul-1', name: 'Require MFA', existed: true, prior: liveRule },
    ])
  })

  it('creates a rule the policy does not have yet and records it as created', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), EMPTY_LIST, ok({ id: 'rul-NEW' })],
      async (calls) => {
        const res = await deploy(
          deployContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] }),
        )

        const writes = writeCalls(calls)
        expect(writes[1].method).toBe('POST')
        expect(writes[1].path).toBe('/policies/pol-1/rules')
        return res
      },
    )

    const entry = (result.rollbackData as { previousState: Array<{ rules: unknown[] }> })
      .previousState[0]
    expect(entry.rules).toEqual([{ id: 'rul-NEW', name: 'Require MFA', existed: false }])
  })

  it('never prunes or deletes a live rule the canvas does not mention', async () => {
    await withFetch(
      [
        ok([LIVE_POLICY]),
        ok({}),
        ok([
          { id: 'rul-sys', name: 'Default Rule', system: true },
          { id: 'rul-1', name: 'Require MFA', system: false },
        ]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        expect(calls.some((c) => c.path.includes('rul-sys'))).toBe(false)
      },
    )
  })

  it('returns a FAILED result rather than throwing when a rule write is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_POLICY]), ok({}), EMPTY_LIST, apiError('Api validation failed: actions', 400)],
      async () =>
        deploy(deployContext({ sections: [policy({ rulesJson: '[{"name":"Require MFA"}]' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create rule "Require MFA"/)
  })

  it('skips rule reconciliation entirely when the canvas declares no rules', async () => {
    await withFetch([ok([LIVE_POLICY]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [policy()] }))
      expect(calls.some((c) => c.path.includes('/rules'))).toBe(false)
    })
  })

  it('ignores a section with no type or name instead of sending a nameless policy', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })
})
