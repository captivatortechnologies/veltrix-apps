// =============================================================================
// event-hooks — deploy, driven against the fake Okta org.
//
// An event hook is an outbound webhook the org fires on identity events, and it
// carries a WRITE-ONLY auth secret Okta never reads back. Getting this wrong
// either points the org's event stream at the wrong endpoint or silently strands
// a hook UNVERIFIED so no event is ever delivered. The tests below assert the
// request sequence, the exact body sent, the verification contract, the rollback
// state recorded — and that neither the SSWS token nor the hook secret is ever
// echoed into a result.
// =============================================================================

import deploy from '../deploy'
import type { LiveEventHook } from '../validate'
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

/** The hook's own write-only auth header value — as sensitive as the SSWS token. */
const SECRET = 'hook-auth-SUPERSECRET-value'

/** The harness only knows about the SSWS token, so the hook secret is checked here. */
function leaksSecret(value: unknown): boolean {
  try {
    return JSON.stringify(value ?? null).includes(SECRET)
  } catch {
    return String(value).includes(SECRET)
  }
}

function hook(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Audit hook',
    fields: {
      name: 'Veltrix audit hook',
      status: 'ACTIVE',
      eventItems: ['user.lifecycle.create', 'user.lifecycle.deactivate'],
      uri: 'https://hooks.example.com/okta',
      authHeaderKey: 'Authorization',
      authHeaderValue: SECRET,
      ...fields,
    },
  }
}

const LIVE_HOOK: LiveEventHook = {
  id: 'ehLIVE',
  name: 'Veltrix audit hook',
  status: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create', 'user.lifecycle.deactivate'] },
  channel: {
    type: 'HTTP',
    version: '1.0.0',
    config: {
      uri: 'https://hooks.example.com/okta',
      authScheme: { type: 'HEADER', key: 'Authorization' },
    },
  },
  _links: { self: { href: `${API_BASE}/eventHooks/ehLIVE` } },
}

describe('event-hooks deploy', () => {
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

  it('sends the SSWS token on its first request and leaks neither secret back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
      expect(leaksSecret(result)).toBe(false)
    })
  })

  it('creates a hook that does not exist, sending the exact channel body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/eventHooks')
      expect(calls[0].method).toBe('GET')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/eventHooks')
      expect(writes[0].json).toEqual({
        name: 'Veltrix audit hook',
        events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create', 'user.lifecycle.deactivate'] },
        channel: {
          type: 'HTTP',
          version: '1.0.0',
          config: {
            uri: 'https://hooks.example.com/okta',
            authScheme: { type: 'HEADER', key: 'Authorization', value: SECRET },
          },
        },
      })
    })
  })

  it('records the created hook so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('ehNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['ehNEW'])
  })

  it('flags a newly created hook for the external verify handshake and never verifies it itself', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect((result.artifacts as { needsVerify: string[] }).needsVerify).toEqual(['Veltrix audit hook'])
      expect(result.message).toMatch(/Verification required/)
      expect(result.message).toMatch(/does NOT auto-verify/)
      // Okta will not deliver events until a human completes the handshake — and
      // the handler must never fake it.
      expect(calls.some((c) => c.path.includes('/lifecycle/verify'))).toBe(false)
    })
  })

  it('fails rather than inventing an id when the create returns none', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a hook that already exists instead of creating a second one', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/eventHooks/ehLIVE')
      expect(calls.some((c) => c.method === 'POST' && c.path === '/eventHooks')).toBe(false)
    })
  })

  it('captures the prior definition with server-managed fields stripped so it is safe to PUT back', async () => {
    const result = await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async () =>
      deploy(deployContext({ sections: [hook()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('ehLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    expect(entry.prior).toEqual({
      name: LIVE_HOOK.name,
      events: LIVE_HOOK.events,
      channel: LIVE_HOOK.channel,
    })
  })

  it('re-asserts the write-only secret on every deploy but keeps it out of the result', async () => {
    const result = await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      const res = await deploy(deployContext({ sections: [hook()] }))

      const sent = writeCalls(calls)[0].json.channel as {
        config: { authScheme: Record<string, unknown> }
      }
      // Okta never returns it, so there is nothing to compare — it must be sent
      // again or the hook silently loses its auth header.
      expect(sent.config.authScheme.value).toBe(SECRET)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksSecret(result)).toBe(false)
    expect(leaksToken(result)).toBe(false)
  })

  it('flags re-verification when the channel changed, and stays quiet when it did not', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async () => {
      const unchanged = await deploy(deployContext({ sections: [hook()] }))
      expect((unchanged.artifacts as { needsVerify: string[] }).needsVerify).toEqual([])
      expect(String(unchanged.message).includes('Verification required')).toBe(false)
    })

    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async () => {
      const moved = await deploy(
        deployContext({ sections: [hook({ uri: 'https://elsewhere.example.com/okta' })] }),
      )
      // Changing the channel clears Okta's verification — the operator has to
      // know the hook has stopped delivering.
      expect((moved.artifacts as { needsVerify: string[] }).needsVerify).toEqual(['Veltrix audit hook'])
    })
  })

  it('reconciles status through the lifecycle endpoint, not the PUT body', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const put = writeCalls(calls)[0]
      expect(put.path).toBe('/eventHooks/ehLIVE')
      expect(put.json.status).toBeUndefined()
      expect(calls.some((c) => c.path === '/eventHooks/ehLIVE/lifecycle/deactivate')).toBe(true)
    })
  })

  it('makes no lifecycle call when the live status already matches', async () => {
    await withFetch([ok([LIVE_HOOK]), ok(LIVE_HOOK)], async (calls) => {
      await deploy(deployContext({ sections: [hook({ status: 'ACTIVE' })] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('deactivates a freshly created hook when INACTIVE was asked for', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/eventHooks/ehNEW/lifecycle/deactivate')).toBe(true)
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

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: channel', 400, ['uri: must be https'])],
      async () => deploy(deployContext({ sections: [hook()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/must be https/)
    expect(leaksToken(result)).toBe(false)
    expect(leaksSecret(result)).toBe(false)
  })

  it('returns a FAILED result and writes nothing when the hook list cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [hook()] }))
      // A 403 on the list must never be read as "the hook is absent" and turned
      // into a duplicate create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list event hooks/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('reports partial progress and keeps rollback state when a later hook fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({ id: 'ehONE', status: 'ACTIVE' }),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [
              hook(),
              { name: 'Second', fields: { ...hook({ name: 'Second hook' }).fields } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['ehONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('follows pagination so a hook on a later page is updated, not duplicated', async () => {
    await withFetch(
      [
        { status: 200, body: [{ id: 'ehOTHER', name: 'Someone else' }], headers: { link: `<${API_BASE}/eventHooks?after=ehOTHER>; rel="next"` } },
        ok([LIVE_HOOK]),
        ok(LIVE_HOOK),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [hook()] }))

        expect(result.success).toBe(true)
        expect(calls.filter((c) => c.method === 'GET' && c.path === '/eventHooks')).toHaveLength(2)
        expect(writeCalls(calls)[0].path).toBe('/eventHooks/ehLIVE')
      },
    )
  })

  it('sends extra static channel headers when the canvas declares them', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [hook({ headersJson: '[{"key":"X-Trace","value":"1"},{"key":"X-Env","value":"prod"}]' })],
        }),
      )

      expect(result.success).toBe(true)
      const config = (writeCalls(calls)[0].json.channel as { config: Record<string, unknown> }).config
      expect(config.headers).toEqual([
        { key: 'X-Trace', value: '1' },
        { key: 'X-Env', value: 'prod' },
      ])
    })
  })

  it('refuses a malformed headers blob before sending anything to the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [hook({ headersJson: '{"key":"X"}' })] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON array/)
      expect(calls).toHaveLength(0)
    })
  })

  it('ignores a section with no hook name rather than creating an unnamed hook', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [hook(), { name: 'Blank', fields: { name: '   ' } }] }),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Deployed 1 event hook/)
      expect(writeCalls(calls)).toHaveLength(1)
    })
  })

  it('does not depend on the platform data API to resolve hooks', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'ehNEW', status: 'ACTIVE' })], async () => {
      // Hooks are matched by name off the live list, so a platform outage must
      // not stop a deploy.
      const result = await deploy(deployContext({ sections: [hook()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
