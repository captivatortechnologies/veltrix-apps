// =============================================================================
// auth-server-claims — deploy, driven against the fake Okta org.
//
// A claim is the payload an authorization server stamps into a token: an
// EXPRESSION claim copies a user attribute, a GROUPS claim copies group
// membership, and `alwaysIncludeInToken` decides whether it rides along even
// when nothing asked for it. Downstream services authorize on these values, so a
// claim written to the wrong value type — or written at all onto an Okta-managed
// system claim — is an authorization bug. Claims are CHILDREN of an
// authorization server and have NO lifecycle endpoint, so status travels in the
// PUT body. These tests assert the requests, bodies, skips and rollback state.
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

function claim(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'department',
    fields: {
      authServerId: 'default',
      name: 'department',
      claimType: 'RESOURCE',
      valueType: 'EXPRESSION',
      value: 'user.department',
      alwaysIncludeInToken: true,
      status: 'ACTIVE',
      scopeConditions: ['partner.read'],
      ...fields,
    },
  }
}

const LIVE_CLAIM = {
  id: 'oclLIVE',
  name: 'department',
  status: 'INACTIVE',
  claimType: 'IDENTITY',
  valueType: 'EXPRESSION',
  value: 'user.oldDepartment',
  alwaysIncludeInToken: false,
  conditions: { scopes: [] },
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com' } },
}

const CLAIMS_PATH = '/authorizationServers/default/claims'

describe('auth-server-claims deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [claim()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [claim()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [claim()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [claim()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('scopes every request to the declared parent authorization server', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim({ authServerId: 'aus1a2b3c' })] }))

      for (const call of calls) {
        expect(call.path.startsWith('/authorizationServers/aus1a2b3c/claims')).toBe(true)
      }
    })
  })

  it('url-encodes a parent id so it can never escape its own collection path', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim({ authServerId: 'aus/../default' })] }))

      expect(calls[0].path).toBe('/authorizationServers/aus%2F..%2Fdefault/claims')
    })
  })

  it('fails with the parent named when the authorization server cannot be resolved', async () => {
    const result = await withFetch([notFound('Not found: authorizationServer')], async (calls) => {
      const res = await deploy(deployContext({ sections: [claim({ authServerId: 'ausGONE' })] }))
      // A parent that does not resolve must never be turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list claims for authorization server "ausGONE"/)
    expect(result.message).toMatch(/0 of 1/)
  })

  it('creates a claim that does not exist and sends the modelled body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [claim()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(CLAIMS_PATH)

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe(CLAIMS_PATH)
      expect(writes[0].json).toEqual({
        name: 'department',
        status: 'ACTIVE',
        claimType: 'RESOURCE',
        valueType: 'EXPRESSION',
        alwaysIncludeInToken: true,
        conditions: { scopes: ['partner.read'] },
        value: 'user.department',
      })
    })
  })

  it('carries status in the body — claims have no lifecycle endpoint', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim({ status: 'INACTIVE' })] }))

      expect(writeCalls(calls)[0].json.status).toBe('INACTIVE')
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('sends group_filter_type only for a GROUPS claim', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            claim({ valueType: 'GROUPS', value: 'eng-.*', groupFilterType: 'STARTS_WITH' }),
          ],
        }),
      )
      expect(writeCalls(calls)[0].json.group_filter_type).toBe('STARTS_WITH')
    })

    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim({ groupFilterType: 'STARTS_WITH' })] }))
      // An EXPRESSION claim ignores the filter type — it must not be sent.
      const body = writeCalls(calls)[0].json
      expect(Object.prototype.hasOwnProperty.call(body, 'group_filter_type')).toBe(false)
    })
  })

  it('omits a blank value rather than sending an empty expression', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim({ valueType: 'SYSTEM', value: '' })] }))

      const body = writeCalls(calls)[0].json
      expect(Object.prototype.hasOwnProperty.call(body, 'value')).toBe(false)
    })
  })

  it('never sends a server-managed field in the create body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [claim()] }))

      const body = writeCalls(calls)[0].json
      expect(body.id).toBeUndefined()
      expect(body.system).toBeUndefined()
      expect(body.created).toBeUndefined()
    })
  })

  it('records the created claim in rollback state so rollback can remove it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async () =>
      deploy(deployContext({ sections: [claim()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('oclNEW')
    expect(rb.previousState[0].authServerId).toBe('default')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['oclNEW'])
  })

  it('fails when the create returns no id rather than recording an unrollbackable claim', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'department' })], async () =>
      deploy(deployContext({ sections: [claim()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a matched claim in place and captures its prior body', async () => {
    const result = await withFetch([ok([LIVE_CLAIM]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [claim()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe(`${CLAIMS_PATH}/oclLIVE`)
      expect(writes[0].json.claimType).toBe('RESOURCE')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('oclLIVE')
    // The captured prior is safe to PUT back: status stays (it is authored via
    // the body) but every server-managed field is gone.
    expect(entry.prior).toEqual({
      name: 'department',
      status: 'INACTIVE',
      claimType: 'IDENTITY',
      valueType: 'EXPRESSION',
      value: 'user.oldDepartment',
      alwaysIncludeInToken: false,
      conditions: { scopes: [] },
    })
  })

  it('matches the claim name only within its own parent authorization server', async () => {
    await withFetch([ok([{ ...LIVE_CLAIM, name: 'other' }]), ok({ id: 'oclNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [claim()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].method).toBe('POST')
    })
  })

  it('leaves a live Okta-managed system claim completely untouched', async () => {
    await withFetch([ok([{ ...LIVE_CLAIM, system: true }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [claim()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
      expect(result.message).toMatch(/Skipped 1 Okta-managed system claim/)
      expect((result.artifacts as { skippedClaims: string[] }).skippedClaims).toEqual([
        'default:department',
      ])
      // Nothing to undo — a skipped claim is never recorded for rollback.
      expect((result.rollbackData as { previousState: unknown[] }).previousState).toHaveLength(0)
    })
  })

  it('follows the rel="next" Link header so a claim on a later page still matches', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'oclOTHER', name: 'other' }],
          headers: { link: `<${API_BASE}${CLAIMS_PATH}?after=oclOTHER>; rel="next"` },
        },
        ok([LIVE_CLAIM]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [claim()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('oclOTHER')
        expect(writeCalls(calls)[0].method).toBe('PUT')
        expect(writeCalls(calls)[0].path).toBe(`${CLAIMS_PATH}/oclLIVE`)
      },
    )
  })

  it('does not depend on the platform data API to resolve a claim', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'oclNEW' })], async () => {
      const result = await deploy(deployContext({ sections: [claim()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [claim({ authServerId: '' }), claim({ name: '' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the list itself is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [claim()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create — that would stamp a second copy of the claim into tokens.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_CLAIM]), apiError('Api validation failed: value', 400, ['value: invalid EL'])],
      async () => deploy(deployContext({ sections: [claim()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update claim "default:department"/)
    expect(result.message).toMatch(/value: invalid EL/)
  })

  it('reports partial progress and keeps rollback state when a later claim fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'oclONE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              claim(),
              {
                name: 'Second',
                fields: {
                  authServerId: 'default',
                  name: 'costCenter',
                  claimType: 'RESOURCE',
                  valueType: 'EXPRESSION',
                  value: 'user.costCenter',
                },
              },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['oclONE'])
    expect(rb.previousState).toHaveLength(1)
    expect((result.artifacts as { deployedClaims: string[] }).deployedClaims).toEqual([
      'default:department',
    ])
  })

  it('never issues a DELETE — deploy only ever creates or replaces', async () => {
    await withFetch([ok([LIVE_CLAIM]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [claim()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })
})
