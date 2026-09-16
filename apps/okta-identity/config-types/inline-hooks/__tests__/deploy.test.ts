// =============================================================================
// inline-hooks — deploy, driven against the fake Okta org.
//
// An inline hook runs INSIDE a live sign-in or token mint: Okta pauses the flow,
// calls the endpoint and applies what it returns. Pointing one at the wrong URI,
// clearing its shared secret or adopting a same-named hook of a different type
// breaks authentication for the whole org. These tests assert the (name, type)
// identity, the exact body sent, the write-only-secret contract and the rollback
// state recorded — and that no secret is ever echoed back.
// =============================================================================

import deploy from '../deploy'
import type { LiveInlineHook } from '../validate'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  EMPTY_LIST,
  emptyCredential,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const HOOK_TYPE = 'com.okta.oauth2.tokens.transform'
/** The hook's shared secret — as sensitive as the SSWS token. */
const SECRET = 'inline-hook-SUPERSECRET-header'
const CLIENT_SECRET = 'oauth-client-SUPERSECRET'

function leaksSecret(value: unknown, secret: string): boolean {
  try {
    return JSON.stringify(value ?? null).includes(secret)
  } catch {
    return String(value).includes(secret)
  }
}

function hook(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Token transform',
    fields: {
      name: 'Veltrix token transform',
      type: HOOK_TYPE,
      status: 'ACTIVE',
      channelType: 'HTTP',
      uri: 'https://hooks.example.com/token',
      authHeaderKey: 'Authorization',
      authHeaderValue: SECRET,
      ...fields,
    },
  }
}

const LIVE_HOOK: LiveInlineHook = {
  id: 'ihLIVE',
  name: 'Veltrix token transform',
  type: HOOK_TYPE,
  version: '1.0.0',
  status: 'ACTIVE',
  system: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  channel: {
    type: 'HTTP',
    version: '1.0.0',
    config: {
      uri: 'https://hooks.example.com/token',
      method: 'POST',
      headers: [],
      authScheme: { type: 'HEADER', key: 'Authorization' },
    },
  },
  _links: { self: { href: `${API_BASE}/inlineHooks/ihLIVE` } },
}

describe('inline-hooks deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [hook()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and leaks no secret back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
      expect(leaksSecret(result, SECRET)).toBe(false)
    })
  })

  it('looks the hook up filtered by type, then creates it with the exact body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/inlineHooks')
      expect(calls[0].query.type).toBe(HOOK_TYPE)

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/inlineHooks')
      expect(writes[0].json).toEqual({
        name: 'Veltrix token transform',
        type: HOOK_TYPE,
        version: '1.0.0',
        channel: {
          type: 'HTTP',
          version: '1.0.0',
          config: {
            uri: 'https://hooks.example.com/token',
            method: 'POST',
            headers: [],
            authScheme: { type: 'HEADER', key: 'Authorization', value: SECRET },
          },
        },
      })
    })
  })

  it('records the created hook so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('ihNEW')
    expect(rb.previousState[0].type).toBe(HOOK_TYPE)
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['ihNEW'])
  })

  it('fails rather than inventing an id when the create returns none', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates the hook in place when the (name, type) pair already exists', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/inlineHooks/ihLIVE')
      expect(calls.some((c) => c.method === 'POST' && c.path === '/inlineHooks')).toBe(false)
    })
  })

  it('never adopts a same-named hook of a different type', async () => {
    await withFetch(
      [ok([{ ...LIVE_HOOK, type: 'com.okta.saml.tokens.transform' }]), ok({ id: 'ihNEW', status: 'ACTIVE' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [hook()] }))

        expect(result.success).toBe(true)
        // Identity is the PAIR — hijacking the SAML hook would rewrite a
        // completely different authentication path.
        const writes = writeCalls(calls)
        expect(writes[0].method).toBe('POST')
        expect(writes[0].path).toBe('/inlineHooks')
      },
    )
  })

  it('captures the prior definition with server-managed fields stripped so it is safe to PUT back', async () => {
    const result = await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('ihLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    expect(entry.prior).toEqual({
      name: LIVE_HOOK.name,
      type: LIVE_HOOK.type,
      version: LIVE_HOOK.version,
      channel: LIVE_HOOK.channel,
    })
  })

  it('omits a blank secret from the body so a re-deploy keeps the stored one', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ authHeaderValue: '' })] }))

      expect(result.success).toBe(true)
      const scheme = (
        (writeCalls(calls)[0].json.channel as { config: Record<string, unknown> }).config
          .authScheme as Record<string, unknown>
      )
      // Sending `value: ''` would blank the shared secret and every hook call
      // would start failing authentication at the endpoint.
      expect(scheme.value).toBeUndefined()
      expect(scheme.key).toBe('Authorization')
    })
  })

  it('defaults the auth header key when the canvas leaves it blank', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [hook({ authHeaderKey: '' })] }))

      const scheme = (
        (writeCalls(calls)[0].json.channel as { config: Record<string, unknown> }).config
          .authScheme as Record<string, unknown>
      )
      expect(scheme.key).toBe('Authorization')
    })
  })

  it('lets the modeled endpoint and auth scheme win over the free-form config blob', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            hook({
              configJson: JSON.stringify({
                uri: 'https://attacker.evil.test/collect',
                authScheme: { type: 'HEADER', key: 'X-Evil', value: 'pwn' },
                method: 'PUT',
              }),
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const config = (writeCalls(calls)[0].json.channel as { config: Record<string, unknown> }).config
      expect(config.uri).toBe('https://hooks.example.com/token')
      expect(config.authScheme).toEqual({ type: 'HEADER', key: 'Authorization', value: SECRET })
      // A method the author set in the blob is still honoured — only the
      // endpoint and header auth are locked to the modeled fields.
      expect(config.method).toBe('PUT')
    })
  })

  it('builds an OAUTH channel without a header auth scheme', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            hook({
              channelType: 'OAUTH',
              configJson: JSON.stringify({
                clientId: 'client-123',
                clientSecret: CLIENT_SECRET,
                tokenUrl: 'https://idp.example.com/token',
                authType: 'client_secret_post',
              }),
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const channel = writeCalls(calls)[0].json.channel as {
        type: string
        config: Record<string, unknown>
      }
      expect(channel.type).toBe('OAUTH')
      expect(channel.config.authScheme).toBeUndefined()
      expect(channel.config.clientId).toBe('client-123')
      expect(channel.config.clientSecret).toBe(CLIENT_SECRET)
      expect(leaksSecret(result, CLIENT_SECRET)).toBe(false)
    })
  })

  it('reconciles status through the lifecycle endpoint, not the PUT body', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.status).toBeUndefined()
      expect(calls.some((c) => c.path === '/inlineHooks/ihLIVE/lifecycle/deactivate')).toBe(true)
    })
  })

  it('makes no lifecycle call when the live status already matches', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      await deploy(deployContext({ sections: [hook({ status: 'ACTIVE' })] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('deactivates a freshly created hook when INACTIVE was asked for', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/inlineHooks/ihNEW/lifecycle/deactivate')).toBe(true)
    })
  })

  it('treats a 404 on the lifecycle transition as the hook already being gone', async () => {
    await withFetch(
      [ok([LIVE_HOOK]), ok(LIVE_HOOK), { status: 404, body: { errorSummary: 'Not found' } }],
      async () => {
        const result = await deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('fails the deploy when the lifecycle transition is genuinely rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_HOOK]), ok(LIVE_HOOK), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/deactivate inline hook/)
    // The PUT already landed — rollback has to know about it.
    expect((result.rollbackData as { previousState: unknown[] }).previousState).toHaveLength(1)
  })

  it('tells the operator the channel endpoint needs re-verifying and never verifies it itself', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(result.message).toMatch(/re-verified/)
      expect(calls.some((c) => c.path.includes('/lifecycle/verify'))).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: channel', 400, ['uri: must be https'])],
      async () => deploy(deployContext({ sections: [hook()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/must be https/)
    expect(leaksToken(result)).toBe(false)
    expect(leaksSecret(result, SECRET)).toBe(false)
  })

  it('returns a FAILED result and writes nothing when the hook list cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [hook()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list inline hooks/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('refuses a malformed config blob before sending anything to the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ configJson: '["not","an","object"]' })] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON object/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports partial progress and keeps rollback state when a later hook fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'ihONE', status: 'ACTIVE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              hook(),
              { name: 'Second', fields: { ...hook({ name: 'Veltrix password import', type: 'com.okta.import.transform' }).fields } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['ihONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('follows pagination so a hook on a later page is updated, not duplicated', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'ihOTHER', name: 'Someone else', type: HOOK_TYPE }],
          headers: { link: `<${API_BASE}/inlineHooks?type=${HOOK_TYPE}&after=ihOTHER>; rel="next"` },
        },
        ok([LIVE_HOOK]),
        ok(LIVE_HOOK),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [hook()] }))

        expect(result.success).toBe(true)
        expect(calls.filter((c) => c.method === 'GET' && c.path === '/inlineHooks')).toHaveLength(2)
        expect(writeCalls(calls)[0].path).toBe('/inlineHooks/ihLIVE')
      },
    )
  })

  it('ignores a section missing a name or a type rather than creating a broken hook', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            hook(),
            { name: 'No type', fields: { name: 'Typeless', type: '' } },
            { name: 'No name', fields: { name: '', type: HOOK_TYPE } },
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Deployed 1 inline hook/)
      expect(writeCalls(calls)).toHaveLength(1)
    })
  })

  it('does not depend on the platform data API to resolve hooks', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ihNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [hook()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
