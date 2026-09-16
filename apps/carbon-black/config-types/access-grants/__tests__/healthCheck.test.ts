import healthCheck from '../healthCheck'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  healthContext,
  mentionsSecret,
  withFetch,
  writes,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'access-grants'
const USERS = `/appservices/v6/orgs/${ORG_KEY}/users`

function ctx(opts: Record<string, unknown> = {}) {
  return healthContext({ configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black access-grants healthCheck handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx({ credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('credential')
      expect(result.checks[0].passed).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx({ settings: NO_ORG_KEY_SETTINGS }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the region base URL is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx({ settings: NO_BASE_URL_SETTINGS }))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('reports healthy after reaching the Users endpoint grants depend on', async () => {
    await withFetch([cbJson({ users: [] })], async (calls) => {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(calls).toHaveLength(1)
      // Grants have no list-all endpoint, so principal resolution is the probe.
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(USERS)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cbc-access-grants')
      expect(result.checks[0].passed).toBe(true)
      expect(result.checks[0].latencyMs).toBeDefined()
    })
  })

  it('never writes while checking health', async () => {
    await withFetch([cbJson({ users: [] })], async (calls) => {
      await healthCheck(ctx())

      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('reports unhealthy with the vendor reason when the endpoint rejects', async () => {
    await withFetch([cbError('API key lacks org.users READ', 403)], async () => {
      const result = await healthCheck(ctx())

      // Without org.users READ no principal can be resolved, so every grant
      // deploy would fail — health must say so rather than pass.
      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cbc-access-grants')
      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toContain('API key lacks org.users READ')
      expect(mentionsSecret(result.checks[0].message)).toBe(false)
    })
  })

  it('reports unhealthy on an unauthenticated response without echoing the secret', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(mentionsSecret(result.checks[0].message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })

  it('reports unhealthy rather than throwing when the request never completes', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toContain('ECONNREFUSED')
    } finally {
      globalThis.fetch = original
    }
  })
})
