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

const SHA_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const LIVE_PLUGIN = {
  status: 200,
  body: { data: { name: 'acme-kv', sha256: SHA_A, command: 'acme-kv', builtin: false } },
}

function ctx(o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      [
        {
          name: 'Plugin 1',
          fields: { type: 'secret', name: 'acme-kv', sha256: SHA_A, command: 'acme-kv' },
        },
      ],
      'plugins',
    ),
    o,
  )
}

describe('Vault Plugin Catalog Health Check Handler', () => {
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

  it('scores 100 when Vault is active, the token is accepted and the plugin is registered', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_PLUGIN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('plugin:secret/acme-kv')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node (429) as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_PLUGIN])
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

  it('fails the per-plugin check when a managed plugin is no longer registered', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not registered/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-plugin check when the name now resolves to a Vault built-in', async () => {
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      { status: 200, body: { data: { name: 'acme-kv', builtin: true } } },
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/BUILT-IN/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the catalog read errors', async () => {
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

  it('still checks a plugin whose canvas entry has no sha256', async () => {
    const canvas = makeCanvas(
      [{ name: 'Plugin 1', fields: { type: 'auth', name: 'acme-auth' } }],
      'plugins',
    )
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(makeHealthCheckContext(canvas))

      expect(result.checks).toHaveLength(3)
      expect(result.checks[2].name).toBe('plugin:auth/acme-auth')
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/auth/acme-auth`)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores one missing plugin out of two as 75', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Plugin 1', fields: { type: 'secret', name: 'first', sha256: SHA_A, command: 'first' } },
        { name: 'Plugin 2', fields: { type: 'secret', name: 'second', sha256: SHA_A, command: 'second' } },
      ],
      'plugins',
    )
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      { status: 200, body: { data: { name: 'first', builtin: false } } },
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
