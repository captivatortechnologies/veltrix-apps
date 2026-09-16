import healthCheck from '../healthCheck'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  healthContext,
  mentionsSecret,
  withFetch,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'device-control-blocks'
const BLOCKS = `/device_control/v3/orgs/${ORG_KEY}/blocks`

function ctx(opts: Record<string, unknown> = {}) {
  return healthContext({ configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black device-control-blocks healthCheck handler', () => {
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
      expect(result.checks[0].name).toBe('credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the region base URL is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx({ settings: NO_BASE_URL_SETTINGS }))

      expect(result.healthy).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports healthy after reaching the device-control blocks endpoint', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(BLOCKS)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.checks[0].name).toBe('cbc-device-control-blocks')
      expect(result.checks[0].passed).toBe(true)
      expect(result.checks[0].latencyMs).toBeDefined()
    })
  })

  it('reports unhealthy with the vendor reason when the endpoint rejects', async () => {
    await withFetch([cbError('API key lacks org.device-control READ', 403)], async () => {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toContain('API key lacks org.device-control READ')
      expect(mentionsSecret(result.checks[0].message)).toBe(false)
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
