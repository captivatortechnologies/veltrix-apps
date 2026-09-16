// =============================================================================
// authenticators — deploy, driven against the fake Okta org.
//
// Authenticators are the factors behind every policy: turn one off and MFA
// silently stops being enforced; create a duplicate and people enrol against the
// wrong one. The API has no upsert and NO DELETE, and built-in okta_* factors are
// seeded one-per-org and must never be created. These tests assert that contract,
// the exact bodies sent (including where the write-only provider secrets land),
// the rollback state recorded, and that a vendor rejection is a FAILED result.
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

function authenticator(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Email',
    fields: { key: 'okta_email', name: 'Email', status: 'ACTIVE', ...fields },
  }
}

const LIVE_EMAIL = {
  id: 'aut-1',
  key: 'okta_email',
  type: 'email',
  name: 'Email',
  status: 'ACTIVE',
  settings: { allowedFor: 'recovery' },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://example.test' } },
}

describe('authenticators deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [authenticator()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [authenticator()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('UPDATES a built-in authenticator in place, preserving the live type and key', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [authenticator({ settingsJson: '{"allowedFor":"any"}' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/authenticators')
      expect(calls[0].method).toBe('GET')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/authenticators/aut-1')
      // Server-managed fields are stripped; status is never sent in the body.
      expect(writes[0].json).toEqual({
        key: 'okta_email',
        type: 'email',
        name: 'Email',
        settings: { allowedFor: 'any' },
      })
    })
  })

  it('keeps the live settings when the canvas declares none', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [authenticator()] }))
      expect(writeCalls(calls)[0].json.settings).toEqual({ allowedFor: 'recovery' })
    })
  })

  it('captures the prior body and status so rollback can replay them', async () => {
    const result = await withFetch([ok([LIVE_EMAIL]), ok({})], async () =>
      deploy(deployContext({ sections: [authenticator({ settingsJson: '{"allowedFor":"any"}' })] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.createdIds).toEqual([])
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].identity).toBe('okta_email')
    expect(rb.previousState[0].existed).toBe(true)
    expect(rb.previousState[0].id).toBe('aut-1')
    expect(rb.previousState[0].priorStatus).toBe('ACTIVE')
    expect(rb.previousState[0].prior).toEqual({
      key: 'okta_email',
      type: 'email',
      name: 'Email',
      settings: { allowedFor: 'recovery' },
    })
  })

  it('REFUSES to create a built-in authenticator the org has not seeded', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [authenticator({ key: 'google_otp' })] }))
      // No POST — inventing a built-in factor would be a second, unmanaged one.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/cannot be created/)
    expect(result.message).toMatch(/google_otp/)
  })

  it('creates a missing creatable authenticator with ?activate=true', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [authenticator({ key: 'custom_otp', name: 'Corporate TOTP' })],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/authenticators')
      expect(writes[0].query.activate).toBe('true')
      expect(writes[0].json).toEqual({
        key: 'custom_otp',
        type: 'app',
        name: 'Corporate TOTP',
      })
    })
  })

  it('accepts the partner terms when creating a custom_app, which Okta requires', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({ sections: [authenticator({ key: 'custom_app', name: 'Acme Push' })] }),
      )

      expect(writeCalls(calls)[0].json.agreeToTerms).toBe(true)
      expect(writeCalls(calls)[0].json.type).toBe('app')
    })
  })

  it('creates a federated external IdP authenticator with the federated type', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({ sections: [authenticator({ key: 'external_idp', name: 'Partner IdP' })] }),
      )

      expect(writeCalls(calls)[0].json.type).toBe('federated')
      expect(writeCalls(calls)[0].json.agreeToTerms).toBeUndefined()
    })
  })

  it('omits the type for a creatable key that has no mapped category', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [authenticator({ key: 'yubikey_token', name: '' })] }))
      expect(writeCalls(calls)[0].json.type).toBeUndefined()
    })
  })

  it('records the created authenticator with no prior body — there was nothing to restore', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })],
      async () =>
        deploy(deployContext({ sections: [authenticator({ key: 'custom_otp', name: 'TOTP' })] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.createdIds).toEqual(['aut-NEW'])
    expect(rb.previousState).toEqual([
      { identity: 'custom_otp::TOTP', key: 'custom_otp', name: 'TOTP', existed: false, id: 'aut-NEW' },
    ])
  })

  it('merges the write-only secrets into the provider configuration it sends', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            authenticator({
              key: 'duo',
              name: 'Duo',
              providerJson: '{"type":"DUO","configuration":{"host":"api-x.duosecurity.com"}}',
              secretKey: 'sk-live-secret',
              integrationKey: 'ik-live-secret',
            }),
          ],
        }),
      )

      expect(writeCalls(calls)[0].json.provider).toEqual({
        type: 'DUO',
        configuration: {
          host: 'api-x.duosecurity.com',
          secretKey: 'sk-live-secret',
          integrationKey: 'ik-live-secret',
        },
      })
      // The secret goes to Okta and nowhere else — not into the result the
      // platform stores and renders.
      expect(JSON.stringify(result).includes('sk-live-secret')).toBe(false)
    })
  })

  it('merges secrets into the live provider configuration on an update', async () => {
    const liveDuo = {
      id: 'aut-duo',
      key: 'duo',
      type: 'app',
      name: 'Duo',
      status: 'ACTIVE',
      provider: { type: 'DUO', configuration: { host: 'api-old.duosecurity.com' } },
    }

    await withFetch([ok([liveDuo]), ok({})], async (calls) => {
      await deploy(
        deployContext({
          sections: [authenticator({ key: 'duo', name: 'Duo', secretKey: 'sk-rotated' })],
        }),
      )

      expect(writeCalls(calls)[0].json.provider).toEqual({
        type: 'DUO',
        configuration: { host: 'api-old.duosecurity.com', secretKey: 'sk-rotated' },
      })
    })
  })

  it('matches a multi-instance authenticator on the (key, name) pair', async () => {
    const liveOne = { id: 'aut-a', key: 'custom_app', name: 'Acme Push', status: 'ACTIVE' }
    const liveTwo = { id: 'aut-b', key: 'custom_app', name: 'Contractor Push', status: 'ACTIVE' }

    await withFetch([ok([liveOne, liveTwo]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [authenticator({ key: 'custom_app', name: 'Contractor Push' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/authenticators/aut-b')
    })
  })

  it('creates a second instance when no live multi-instance authenticator has that name', async () => {
    const liveOne = { id: 'aut-a', key: 'custom_app', name: 'Acme Push', status: 'ACTIVE' }

    await withFetch([ok([liveOne]), ok({ id: 'aut-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({ sections: [authenticator({ key: 'custom_app', name: 'Contractor Push' })] }),
      )

      expect(writeCalls(calls)[0].method).toBe('POST')
      expect(writeCalls(calls)[0].json.name).toBe('Contractor Push')
    })
  })

  it('matches a built-in authenticator on the key alone, whatever it is named live', async () => {
    await withFetch([ok([{ ...LIVE_EMAIL, name: 'Renamed by an admin' }]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/authenticators/aut-1')
    })
  })

  it('follows pagination when the authenticator list spans pages', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'aut-x', key: 'okta_verify', status: 'ACTIVE' }],
          headers: { link: `<${API_BASE}/authenticators?after=abc>; rel="next"` },
        },
        ok([LIVE_EMAIL]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [authenticator()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('abc')
        expect(writeCalls(calls)[0].path).toBe('/authenticators/aut-1')
      },
    )
  })

  it('deactivates through the lifecycle endpoint, never through the PUT body', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].json.status).toBeUndefined()
      expect(writes[1].path).toBe('/authenticators/aut-1/lifecycle/deactivate')
    })
  })

  it('activates an authenticator an admin had turned off', async () => {
    await withFetch([ok([{ ...LIVE_EMAIL, status: 'INACTIVE' }]), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [authenticator({ status: 'ACTIVE' })] }))
      expect(writeCalls(calls)[1].path).toBe('/authenticators/aut-1/lifecycle/activate')
    })
  })

  it('leaves the lifecycle alone when the authenticator is already in the desired status', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [authenticator()] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('never deactivates okta_password, and says why in the result', async () => {
    const live = { id: 'aut-pw', key: 'okta_password', type: 'password', name: 'Password', status: 'ACTIVE' }

    await withFetch([ok([live]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [authenticator({ key: 'okta_password', name: 'Password', status: 'INACTIVE' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
      expect(result.message).toMatch(/cannot be deactivated/)
    })
  })

  it('deactivates a freshly created authenticator that should not be live yet', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'aut-NEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [authenticator({ key: 'custom_otp', name: 'TOTP', status: 'INACTIVE' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/authenticators/aut-NEW/lifecycle/deactivate')).toBe(true)
    })
  })

  it('treats a 404 on the lifecycle transition as already-in-that-state', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({}), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [authenticator({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('fails the deploy when the lifecycle transition is rejected outright', async () => {
    const result = await withFetch(
      [ok([LIVE_EMAIL]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [authenticator({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate authenticator/)
    expect(leaksToken(result)).toBe(false)
  })

  it('never issues a DELETE — the Okta authenticator API has none', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator({ status: 'INACTIVE' })] }))

      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(result.message).toMatch(/never deleted/)
    })
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [authenticator()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list authenticators/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_EMAIL]), apiError('Api validation failed: settings', 400, ['allowedFor: invalid'])],
      async () => deploy(deployContext({ sections: [authenticator()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update authenticator "okta_email"/)
    expect(result.message).toMatch(/allowedFor: invalid/)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Duo is not enabled for this org', 400)],
      async () => deploy(deployContext({ sections: [authenticator({ key: 'duo', name: 'Duo' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create authenticator "duo"/)
  })

  it('fails loudly when a create succeeds but the API returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [authenticator({ key: 'duo', name: 'Duo' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('reports partial progress and keeps rollback state when a later authenticator fails', async () => {
    const result = await withFetch(
      [ok([LIVE_EMAIL]), ok({}), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [authenticator(), authenticator({ key: 'duo', name: 'Duo' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.createdIds).toEqual([])
  })

  it('ignores a section with no key rather than sending a keyless authenticator', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { key: '' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('normalises an upper-case key so it still matches the live authenticator', async () => {
    await withFetch([ok([LIVE_EMAIL]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [authenticator({ key: 'OKTA_EMAIL' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/authenticators/aut-1')
    })
  })
})
