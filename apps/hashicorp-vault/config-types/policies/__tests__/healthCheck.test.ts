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

const HCL = 'path "secret/data/app/*" {\n  capabilities = ["read"]\n}'

function ctx(o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas([{ name: 'Policy 1', fields: { name: 'app-read', policy: HCL } }], 'policies'),
    o,
  )
}

describe('Vault ACL Policies Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx({ token: null }))

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
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      { status: 200, body: { data: { name: 'app-read', policy: HCL } } },
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([
      { status: 429, body: { standby: true } },
      TOKEN_OK,
      { status: 200, body: { data: { name: 'app-read', policy: HCL } } },
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/standby/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the reachability check when Vault is sealed and skips the policy checks', async () => {
    const fetchStub = recordFetch([{ status: 503, body: { sealed: true } }, TOKEN_OK])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/sealed/i)
      // Reachability failed, so no per-policy checks were attempted.
      expect(result.checks).toHaveLength(2)
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
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the token check when Vault rejects the token, without echoing it', async () => {
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[1].name).toBe('vault_token')
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      expect(result.checks).toHaveLength(2)
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
      expect(result.checks[2].name).toBe('policy:app-read')
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/does not exist/i)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the policy read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })
})
