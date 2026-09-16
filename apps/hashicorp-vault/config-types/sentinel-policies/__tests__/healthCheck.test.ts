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

const SENTINEL = 'main = rule {\n  true\n}'
const RGP = { scope: 'rgp', name: 'require-admin', policy: SENTINEL, enforcementLevel: 'advisory' }

function ctx(policies: Array<Record<string, unknown>> = [RGP], o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      policies.map((fields, i) => ({ name: `Policy ${i + 1}`, fields })),
      'sentinel-policies',
    ),
    o,
  )
}

const LIVE_POLICY = {
  status: 200,
  body: { data: { name: 'require-admin', policy: SENTINEL, enforcement_level: 'advisory' } },
}

describe('Vault Sentinel Policies Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx([RGP], { token: null }))

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
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('policy:rgp/require-admin')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('looks an EGP up under the egp endpoint', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(
        ctx([
          {
            scope: 'egp',
            name: 'guard-secrets',
            policy: SENTINEL,
            enforcementLevel: 'advisory',
            paths: ['secret/*'],
          },
        ]),
      )

      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/policies/egp/guard-secrets`)
      expect(result.checks[2].name).toBe('policy:egp/guard-secrets')
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a DR secondary as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 472, body: {} }, TOKEN_OK, LIVE_POLICY])
    try {
      const result = await healthCheck(ctx())

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
      expect(result.checks).toHaveLength(3)
      expect(result.score).toBe(33)
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
      expect(result.checks[2].message).toMatch('Sentinel policy "rgp/require-admin" is not present')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the policy read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to read Sentinel policy/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips incompletely declared policies instead of checking them', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK])
    try {
      const result = await healthCheck(ctx([{ ...RGP, policy: '' }]))

      expect(result.checks).toHaveLength(2)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
