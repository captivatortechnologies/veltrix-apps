import type { AppRouteContext } from '@veltrixsecops/app-sdk'
import { getLiveLicenseStatus, mapLiveLicenses } from '../liveLicense'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-07-20T00:00:00Z')
const epoch = (offsetDays: number) => Math.floor((now.getTime() + offsetDays * DAY) / 1000)

// Shape of /services/licenser/licenses?output_mode=json
const licensesJson = {
  entry: [
    {
      name: 'lic-a',
      content: {
        label: 'Prod A',
        type: 'enterprise',
        stack_id: 'enterprise',
        quota: 500,
        status: 'VALID',
        expiration_time: epoch(90),
      },
    },
    {
      name: 'lic-b',
      content: {
        label: 'Prod B',
        type: 'enterprise',
        stack_id: 'enterprise',
        quota: 250,
        status: 'VALID',
        expiration_time: epoch(30), // earlier expiry within the same stack
      },
    },
  ],
}

// Shape of /services/licenser/pools?output_mode=json
const poolsJson = {
  entry: [
    { name: 'auto_generated_pool_enterprise', content: { stack_id: 'enterprise', used_bytes: 300 } },
    { name: 'pool-2', content: { stack_id: 'enterprise', used_bytes: 100 } },
  ],
}

describe('mapLiveLicenses', () => {
  it('aggregates quota per stack and keeps the earliest expiry', () => {
    const [stack] = mapLiveLicenses(licensesJson, poolsJson, now)
    expect(stack.stackId).toBe('enterprise')
    expect(stack.quotaBytes).toBe(750) // 500 + 250
    // earliest of +90d / +30d
    expect(new Date(stack.expirationTime!).getTime()).toBe(epoch(30) * 1000)
    expect(stack.daysToExpiry).toBe(30)
  })

  it('folds real-time used_bytes from pools', () => {
    const [stack] = mapLiveLicenses(licensesJson, poolsJson, now)
    expect(stack.usedBytes).toBe(400) // 300 + 100
  })

  it('reports usage as null when pool data is unavailable', () => {
    const [stack] = mapLiveLicenses(licensesJson, null, now)
    expect(stack.usedBytes).toBeNull()
    expect(stack.quotaBytes).toBe(750)
  })

  it('returns an empty list for an empty licenser response', () => {
    expect(mapLiveLicenses({ entry: [] }, null, now)).toEqual([])
    expect(mapLiveLicenses({}, null, now)).toEqual([])
  })
})

// --- getLiveLicenseStatus: the seam-driven orchestration -------------------
//
// The live read now flows through the platform credential seam
// (ctx.resolveConnection) — no db / raw-SQL / decrypt to mock. We supply a plain
// async resolver returning a ResolvedConnection (or null), and stub global fetch
// to stand in for splunkd's REST responses.

/** The decrypted-connection shape the seam returns, derived from the SDK type. */
type ResolvedConn = Awaited<ReturnType<AppRouteContext['resolveConnection']>>

const CONNECTION: NonNullable<ResolvedConn> = {
  id: 'cred-1',
  name: 'prod-idxc',
  endpoint: 'splunk.internal:8089',
  username: 'admin',
  password: 'pw',
  apiToken: null,
  certificate: null,
}

/** A resolver that always yields the given connection (or null). */
const resolverReturning =
  (conn: ResolvedConn): AppRouteContext['resolveConnection'] =>
  async () =>
    conn

interface StubRoute {
  status?: number
  body?: unknown
  throws?: boolean
}

/** Swap global fetch for a URL-routed stub; returns a restore fn. */
function installFetch(routeFor: (url: string) => StubRoute): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    const route = routeFor(url)
    if (route.throws) throw new Error('ECONNREFUSED splunk.internal:8089')
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {})),
    }
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('getLiveLicenseStatus', () => {
  it('returns no-connection when the seam resolves nothing', async () => {
    const result = await getLiveLicenseStatus(resolverReturning(null), 'cust-1', 'cred-x')
    expect(result).toEqual({ available: false, reason: 'no-connection' })
  })

  it('returns no-connection when the connection has no endpoint', async () => {
    const result = await getLiveLicenseStatus(
      resolverReturning({ ...CONNECTION, endpoint: null }),
      'cust-1',
      'cred-1',
    )
    expect(result).toEqual({ available: false, reason: 'no-connection' })
  })

  it('reads live licenses + pools and maps per-stack usage', async () => {
    const restore = installFetch((url) =>
      url.includes('/licenser/licenses')
        ? { body: licensesJson }
        : url.includes('/licenser/pools')
          ? { body: poolsJson }
          : { status: 404 },
    )
    try {
      const result = await getLiveLicenseStatus(resolverReturning(CONNECTION), 'cust-1', 'cred-1')
      expect(result.available).toBe(true)
      // endpoint is normalized to an https base URL with no trailing slash.
      expect(result.endpoint).toBe('https://splunk.internal:8089')
      expect(result.stacks).toHaveLength(1)
      expect(result.stacks![0].quotaBytes).toBe(750)
      expect(result.stacks![0].usedBytes).toBe(400)
    } finally {
      restore()
    }
  })

  it('treats pools as best-effort — usage is null when that call fails', async () => {
    const restore = installFetch((url) =>
      url.includes('/licenser/licenses') ? { body: licensesJson } : { throws: true },
    )
    try {
      const result = await getLiveLicenseStatus(resolverReturning(CONNECTION), 'cust-1', 'cred-1')
      expect(result.available).toBe(true)
      expect(result.stacks![0].usedBytes).toBeNull()
    } finally {
      restore()
    }
  })

  it('fails closed to auth on a 401 from the licenses call', async () => {
    const restore = installFetch(() => ({ status: 401, body: 'unauthorized' }))
    try {
      const result = await getLiveLicenseStatus(resolverReturning(CONNECTION), 'cust-1', 'cred-1')
      expect(result.available).toBe(false)
      expect(result.reason).toBe('auth')
      expect(result.endpoint).toBe('https://splunk.internal:8089')
    } finally {
      restore()
    }
  })

  it('fails closed to unreachable when the instance cannot be reached', async () => {
    const restore = installFetch(() => ({ throws: true }))
    try {
      const result = await getLiveLicenseStatus(resolverReturning(CONNECTION), 'cust-1', 'cred-1')
      expect(result.available).toBe(false)
      expect(result.reason).toBe('unreachable')
    } finally {
      restore()
    }
  })
})
