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

const ROLE_PRESENT = { status: 200, body: { data: { ttl: '72h' } } }

function ctx(
  roles: Array<Record<string, unknown>> = [{ mount: 'pki', name: 'web' }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeHealthCheckContext(
    makeCanvas(
      roles.map((fields, i) => ({ name: `Role ${i + 1}`, fields })),
      'pki-roles',
    ),
    o,
  )
}

describe('Vault PKI Roles Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx(undefined, { token: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('vault_credential')
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a zero score without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx(undefined, { hostname: '' }))

      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores 100 when Vault is active, the token is accepted and the role is present', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, ROLE_PRESENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/pki/roles/web`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('role:pki/web')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, ROLE_PRESENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/reachable and unsealed/)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a DR secondary as reachable', async () => {
    const fetchStub = recordFetch([{ status: 472, body: {} }, TOKEN_OK, ROLE_PRESENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a performance standby as reachable', async () => {
    const fetchStub = recordFetch([{ status: 473, body: {} }, TOKEN_OK, ROLE_PRESENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails on a sealed Vault and stops before the token and role probes', async () => {
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

  it('fails on an uninitialized Vault', async () => {
    const fetchStub = recordFetch([{ status: 501, body: { initialized: false } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/not initialized/i)
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
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN, ROLE_PRESENT])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[1].name).toBe('vault_token')
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      expect(result.score).toBe(67)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-role check when a managed role has vanished', async () => {
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

  it('reports a failed check rather than throwing when the role read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to read PKI role/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores the mix when one of two managed roles is gone', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, ROLE_PRESENT, NOT_FOUND])
    try {
      const result = await healthCheck(
        ctx([
          { mount: 'pki', name: 'web' },
          { mount: 'pki', name: 'api' },
        ]),
      )

      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(75)
      expect(result.healthy).toBe(false)
      expect(fetchStub.calls).toHaveLength(4)
    } finally {
      fetchStub.restore()
    }
  })

  it('checks nothing beyond the cluster when the canvas declares no role', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK])
    try {
      const result = await healthCheck(ctx([]))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(2)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
