import {
  deriveProviderCode,
  deriveSubnetPrefix,
  resolvePlanNetwork,
  reserveDeployNetwork,
  NetworkAllocationConflictError,
  type ByolNetworkInfra,
} from '../byolNetwork'

// =============================================================================
// BYOL network + tag enrichment — verified against a stubbed platform network
// allocator (no live calls). Pins that Plan peeks (never commits), Deploy
// reserves + surfaces a 409 as a conflict, tags are always derived, and every
// path degrades gracefully when the allocator is absent or unreachable.
// =============================================================================

const CLOUD: ByolNetworkInfra = {
  id: 'infra-1',
  name: 'Prod Splunk',
  environmentType: 'prod',
  region: 'us-east-1',
  hosting_type: 'AWS',
  cloudProviderId: 'cp-aws',
}

const SELF_HOSTED: ByolNetworkInfra = {
  id: 'infra-2',
  name: 'Lab',
  environmentType: 'dev',
  region: 'local',
  hosting_type: 'Self-Hosted',
  cloudProviderId: null,
}

const API_URL = 'http://platform.internal'
const APP_ID = 'splunk-enterprise'
const CUST = 'cust-1'

interface FetchCall {
  url: string
  method: string
  body: any
}

/** Install a stub fetch; returns the array recording every call it received. */
function installFetch(handler: (call: FetchCall) => { status?: number; body?: unknown }): FetchCall[] {
  const calls: FetchCall[] = []
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init: Record<string, unknown> = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const call: FetchCall = { url: String(url), method: String(init.method ?? 'GET'), body }
    calls.push(call)
    const r = handler(call)
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body ?? {} }
  }
  return calls
}

/** Run `fn` with the allocator base URL set (or cleared) and fetch restored after. */
async function run(url: string | null, fn: () => Promise<void>): Promise<void> {
  const prevUrl = process.env.VELTRIX_NETWORK_API_URL
  const prevFetch = (globalThis as unknown as { fetch: unknown }).fetch
  try {
    if (url) process.env.VELTRIX_NETWORK_API_URL = url
    else delete process.env.VELTRIX_NETWORK_API_URL
    await fn()
  } finally {
    if (prevUrl === undefined) delete process.env.VELTRIX_NETWORK_API_URL
    else process.env.VELTRIX_NETWORK_API_URL = prevUrl
    ;(globalThis as unknown as { fetch: unknown }).fetch = prevFetch
  }
}

const PEEK_BODY = { networkRef: 'vpc-shared-use1', subnetCidr: '10.20.4.0/24', customerBlock: '10.20.0.0/20' }
const ALLOC_BODY = { allocationId: 'alloc-9', ...PEEK_BODY }

describe('deriveProviderCode', () => {
  it('maps a known cloud vendor name to its provider code', () => {
    expect(deriveProviderCode(CLOUD)).toBe('aws')
    expect(deriveProviderCode({ ...CLOUD, hosting_type: 'Microsoft Azure' })).toBe('azure')
    expect(deriveProviderCode({ ...CLOUD, hosting_type: 'Google Cloud' })).toBe('gcp')
    expect(deriveProviderCode({ ...CLOUD, hosting_type: 'Hetzner' })).toBe('hetzner')
  })

  it('returns null for a self-hosted stack (no cloud provider attached)', () => {
    expect(deriveProviderCode(SELF_HOSTED)).toBeNull()
  })

  it('passes an unknown cloud vendor through, lowercased', () => {
    expect(deriveProviderCode({ ...CLOUD, hosting_type: 'OVH' })).toBe('ovh')
  })
})

describe('deriveSubnetPrefix', () => {
  it('requests a /24 per stack', () => {
    expect(deriveSubnetPrefix(CLOUD)).toBe(24)
    expect(deriveSubnetPrefix(SELF_HOSTED)).toBe(24)
  })
})

describe('resolvePlanNetwork (Plan — peek, side-effect-free)', () => {
  it('peeks a candidate subnet and derives tags for a cloud stack', async () => {
    await run(API_URL, async () => {
      const calls = installFetch(() => ({ body: PEEK_BODY }))
      const result = await resolvePlanNetwork(CLOUD, CUST, APP_ID)

      expect(result.network).toEqual({ networkRef: 'vpc-shared-use1', subnetCidr: '10.20.4.0/24' })
      expect(result.networkUnavailable).toBeUndefined()
      expect(result.tags['Veltrix:Customer']).toBe(CUST)
      expect(result.tags['Veltrix:App']).toBe(APP_ID)

      // Hits the PEEK endpoint (never the commit endpoint) with the derived request.
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${API_URL}/api/network/allocations/peek`)
      expect(calls[0].method).toBe('POST')
      expect(calls[0].body).toEqual({ provider: 'aws', region: 'us-east-1', customerId: CUST, prefix: 24 })
    })
  })

  it('returns tags only (no network, no flag) for a self-hosted stack', async () => {
    await run(API_URL, async () => {
      const calls = installFetch(() => ({ body: PEEK_BODY }))
      const result = await resolvePlanNetwork(SELF_HOSTED, CUST, APP_ID)

      expect(result.network).toBeUndefined()
      expect(result.networkUnavailable).toBeUndefined()
      expect(result.tags['Veltrix:EnvType']).toBe('dev')
      expect(calls).toHaveLength(0) // a Network does not apply → allocator never called
    })
  })

  it('degrades to tags + a soft flag when the allocator is not configured', async () => {
    await run(null, async () => {
      const result = await resolvePlanNetwork(CLOUD, CUST, APP_ID)
      expect(result.network).toBeUndefined()
      expect(result.networkUnavailable).toBe(true)
      expect(result.tags['Veltrix:Customer']).toBe(CUST)
    })
  })

  it('degrades to tags + a soft flag when the peek call fails (never throws)', async () => {
    await run(API_URL, async () => {
      installFetch(() => {
        throw new Error('connection refused')
      })
      const result = await resolvePlanNetwork(CLOUD, CUST, APP_ID)
      expect(result.network).toBeUndefined()
      expect(result.networkUnavailable).toBe(true)
    })
  })
})

describe('reserveDeployNetwork (Deploy — atomic reserve)', () => {
  it('reserves the subnet and carries the allocation id + tags', async () => {
    await run(API_URL, async () => {
      const calls = installFetch(() => ({ body: ALLOC_BODY }))
      const result = await reserveDeployNetwork(CLOUD, { customerId: CUST, appId: APP_ID, infrastructureId: 'infra-1' })

      expect(result.network).toEqual({
        networkRef: 'vpc-shared-use1',
        subnetCidr: '10.20.4.0/24',
        allocationId: 'alloc-9',
      })
      expect(result.tags['Veltrix:Environment']).toBe('infra-1')

      // Hits the COMMIT endpoint with the infra + app carried for the ledger row.
      expect(calls[0].url).toBe(`${API_URL}/api/network/allocations`)
      expect(calls[0].body.appId).toBe(APP_ID)
      expect(calls[0].body.infrastructureId).toBe('infra-1')
      expect(calls[0].body.prefix).toBe(24)
    })
  })

  it('throws NetworkAllocationConflictError on a 409 (Plan/Apply CIDR race)', async () => {
    await run(API_URL, async () => {
      installFetch(() => ({ status: 409 }))
      let caught: unknown
      try {
        await reserveDeployNetwork(CLOUD, { customerId: CUST, appId: APP_ID, infrastructureId: 'infra-1' })
      } catch (err) {
        caught = err
      }
      expect(caught instanceof NetworkAllocationConflictError).toBeTruthy()
    })
  })

  it('degrades to tags only (no throw) when the allocator is not configured', async () => {
    await run(null, async () => {
      const result = await reserveDeployNetwork(CLOUD, { customerId: CUST, appId: APP_ID, infrastructureId: 'infra-1' })
      expect(result.network).toBeUndefined()
      expect(result.tags['Veltrix:App']).toBe(APP_ID)
    })
  })

  it('degrades to tags only on a non-conflict transport failure', async () => {
    await run(API_URL, async () => {
      installFetch(() => ({ status: 500 }))
      const result = await reserveDeployNetwork(CLOUD, { customerId: CUST, appId: APP_ID, infrastructureId: 'infra-1' })
      expect(result.network).toBeUndefined()
      expect(result.tags['Veltrix:Customer']).toBe(CUST)
    })
  })
})
