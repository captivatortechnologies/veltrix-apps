import healthCheck from '../healthCheck'
import {
  FORBIDDEN,
  HEALTHY,
  NOT_FOUND,
  TOKEN_OK,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeHealthCheckContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function ctx(paths: string[] = ['team-a'], o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      paths.map((path, i) => ({ name: `Namespace ${i + 1}`, fields: { path } })),
      'namespaces',
    ),
    o,
  )
}

const LIVE_NS = { status: 200, body: { data: { path: 'team-a/' } } }

describe('Vault Namespaces Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx(['team-a'], { token: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('vault_credential')
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores 100 when Vault is active, the token is accepted and the namespace exists', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_NS])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('namespace:team-a')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_NS])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a DR secondary as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 472, body: {} }, TOKEN_OK, LIVE_NS])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
      expect(result.score).toBe(100)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops after the reachability check when Vault is sealed', async () => {
    const fetchStub = recordFetch([{ status: 503, body: { sealed: true } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch(/sealed/i)
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check when Vault is uninitialized', async () => {
    const fetchStub = recordFetch([{ status: 501, body: { initialized: false } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch(/not initialized/i)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check on an unexpected status', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/unexpected status 500/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the token check when Vault rejects the token, without echoing it', async () => {
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[1].name).toBe('vault_token')
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      // The per-namespace checks still run and fail on the same rejection.
      expect(result.checks).toHaveLength(3)
      expect(result.score).toBe(33)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-namespace check when a managed namespace has vanished', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].name).toBe('namespace:team-a')
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not present/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the namespace read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to read namespace "team-a"/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('checks every declared namespace independently', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_NS, NOT_FOUND])
    try {
      const result = await healthCheck(ctx(['team-a', 'team-a/dev']))

      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(75)
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a/dev`)
    } finally {
      fetchStub.restore()
    }
  })
})
