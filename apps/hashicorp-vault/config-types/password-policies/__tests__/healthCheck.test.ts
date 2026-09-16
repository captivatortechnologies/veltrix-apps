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

const HCL = 'length = 20\nrule "charset" {\n  charset = "abc"\n  min-chars = 1\n}'

function ctx(names: string[] = ['db-password'], o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      names.map((name, i) => ({ name: `Policy ${i + 1}`, fields: { name, policy: HCL } })),
      'password-policies',
    ),
    o,
  )
}

const LIVE_POLICY = { status: 200, body: { data: { policy: HCL } } }

describe('Vault Password Policies Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx(['db-password'], { token: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('vault_credential')
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores 100 when Vault is active, the token is accepted and the policy exists', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/policies/password/db-password`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('password-policy:db-password')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('names the accepted token by its display name, never by its value', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[1].message).toMatch(/Token accepted \(token\)/)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('describes a standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/standby node/)
    } finally {
      fetchStub.restore()
    }
  })

  it('describes a performance standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 473, body: {} }, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
      expect(result.checks[0].message).toMatch(/performance standby/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check when Vault is sealed and skips the policy checks', async () => {
    const fetchStub = recordFetch([{ status: 503, body: { sealed: true } }, TOKEN_OK])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(2)
      expect(result.score).toBe(50)
      expect(result.checks[0].message).toMatch(/sealed/i)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check when Vault is uninitialized', async () => {
    const fetchStub = recordFetch([{ status: 501, body: { initialized: false } }, TOKEN_OK])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/not initialized/i)
      expect(result.checks).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check on an unexpected status', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }, TOKEN_OK])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/unexpected status/)
      expect(result.checks[0].message).toMatch(/internal error/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the token check when Vault rejects the token, without echoing it', async () => {
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(2)
      expect(result.score).toBe(50)
      expect(result.checks[1].name).toBe('vault_token')
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-policy check when a managed policy has vanished', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch('Password policy "db-password" does not exist in Vault')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the policy read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to read password policy "db-password"/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('checks every declared policy independently', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_POLICY, NOT_FOUND])
    try {
      const result = await healthCheck(ctx(['db-password', 'api-password']))

      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(75)
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/sys/policies/password/api-password`)
    } finally {
      fetchStub.restore()
    }
  })
})
