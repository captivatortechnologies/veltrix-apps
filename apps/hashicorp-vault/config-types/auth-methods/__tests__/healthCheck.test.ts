import healthCheck from '../healthCheck'
import type { LiveAuthMethod } from '../validate'
import {
  FORBIDDEN,
  HEALTHY,
  TOKEN_OK,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeHealthCheckContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function liveMethods(map: Record<string, LiveAuthMethod>) {
  return { status: 200, body: { data: map } }
}

function ctx(
  methods: Array<Record<string, unknown>> = [{ path: 'userpass', type: 'userpass' }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeHealthCheckContext(
    makeCanvas(
      methods.map((fields, i) => ({ name: `Method ${i + 1}`, fields })),
      'auth-methods',
    ),
    o,
  )
}

describe('Vault Auth Methods Health Check Handler', () => {
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

  it('scores 100 when Vault is active, the token is accepted and the method is enabled', async () => {
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      liveMethods({ 'userpass/': { type: 'userpass' } }),
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/auth`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('authMethod:userpass')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable', async () => {
    const fetchStub = recordFetch([
      { status: 429, body: { standby: true } },
      TOKEN_OK,
      liveMethods({ 'userpass/': { type: 'userpass' } }),
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/health HTTP 429/)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a performance-standby node as reachable', async () => {
    const fetchStub = recordFetch([
      { status: 473, body: { performance_standby: true } },
      TOKEN_OK,
      liveMethods({ 'userpass/': { type: 'userpass' } }),
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/health HTTP 473/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails on a sealed Vault and never tries the token or the mount list', async () => {
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
      expect(fetchStub.calls).toHaveLength(1)
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
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      // A rejected token stops the per-method checks.
      expect(fetchStub.calls).toHaveLength(2)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-method check when a managed mount has vanished', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveMethods({ 'approle/': { type: 'approle' } })])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not enabled/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-method check when another method type occupies the path', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveMethods({ 'userpass/': { type: 'ldap' } })])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[2].message).toMatch(/has type "ldap", expected "userpass"/)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails every per-method check rather than throwing when the mount list errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(
        ctx([
          { path: 'userpass', type: 'userpass' },
          { path: 'approle', type: 'approle' },
        ]),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(4)
      // 2 of 4 passed.
      expect(result.score).toBe(50)
      expect(result.checks[2].message).toMatch(/Could not list auth methods/)
      expect(result.checks[3].message).toMatch(/permission denied/)
      // One list serves every method — it is not repeated per spec.
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores the mix when one of two managed mounts is gone', async () => {
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      liveMethods({ 'userpass/': { type: 'userpass' } }),
    ])
    try {
      const result = await healthCheck(
        ctx([
          { path: 'userpass', type: 'userpass' },
          { path: 'approle', type: 'approle' },
        ]),
      )

      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(75)
      expect(result.healthy).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips the mount list entirely when the canvas declares no method', async () => {
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
