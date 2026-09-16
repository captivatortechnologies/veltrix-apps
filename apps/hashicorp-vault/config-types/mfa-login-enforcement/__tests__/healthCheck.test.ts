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

const METHOD_A = '11111111-1111-4111-8111-111111111111'

const LIVE_ENFORCEMENT = {
  status: 200,
  body: { data: { name: 'admin-mfa', mfa_method_ids: [METHOD_A], auth_method_types: ['userpass'] } },
}

function ctx(o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      [
        {
          name: 'Enforcement 1',
          fields: { name: 'admin-mfa', mfaMethodIds: METHOD_A, authMethodTypes: 'userpass' },
        },
      ],
      'mfa-login-enforcement',
    ),
    o,
  )
}

describe('Vault Login-MFA Enforcement Health Check Handler', () => {
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

  it('scores 100 when Vault is active, the token is accepted and the enforcement exists', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_ENFORCEMENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('enforcement:admin-mfa')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node (429) as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_ENFORCEMENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails reachability when Vault is sealed and stops before the token check', async () => {
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

  it('fails reachability when Vault is uninitialized', async () => {
    const fetchStub = recordFetch([{ status: 501, body: { initialized: false } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/not initialized/i)
      expect(result.checks).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails reachability on an unexpected health status', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['boom'] } }])
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
      expect(result.score).toBe(33)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-enforcement check when a managed enforcement has vanished', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not present/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the enforcement read errors', async () => {
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

  it('does not check an enforcement the deploy would have skipped', async () => {
    const canvas = makeCanvas(
      [{ name: 'Enforcement 1', fields: { name: 'no-methods', authMethodTypes: 'userpass' } }],
      'mfa-login-enforcement',
    )
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK])
    try {
      const result = await healthCheck(makeHealthCheckContext(canvas))

      expect(result.checks).toHaveLength(2)
      expect(result.score).toBe(100)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores one missing enforcement out of two as 75', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Enforcement 1', fields: { name: 'first', mfaMethodIds: METHOD_A } },
        { name: 'Enforcement 2', fields: { name: 'second', mfaMethodIds: METHOD_A } },
      ],
      'mfa-login-enforcement',
    )
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      { status: 200, body: { data: { name: 'first', mfa_method_ids: [METHOD_A] } } },
      NOT_FOUND,
    ])
    try {
      const result = await healthCheck(makeHealthCheckContext(canvas))

      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(75)
      expect(result.checks[3].passed).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })
})
