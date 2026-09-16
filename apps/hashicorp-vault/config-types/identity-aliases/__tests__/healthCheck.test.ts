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

const ACCESSOR = 'auth_userpass_1a2b3c4d'
const ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000001'
const KEY = `entity/${ACCESSOR}/alice`

const listOf = (keys: string[]) => ({ status: 200, body: { data: { keys } } })
const LIVE_ALIAS = {
  status: 200,
  body: { data: { id: 'al-1', name: 'alice', canonical_id: ENTITY_ID, mount_accessor: ACCESSOR } },
}

function ctx(o: { token?: string | null } = {}) {
  return makeHealthCheckContext(
    makeCanvas(
      [
        {
          name: 'Alias 1',
          fields: { kind: 'entity', name: 'alice', canonicalId: ENTITY_ID, mountAccessor: ACCESSOR },
        },
      ],
      'identity-aliases',
    ),
    o,
  )
}

describe('Vault Identity Aliases Health Check Handler', () => {
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

  it('scores 100 when Vault is active, the token is accepted and the alias is present', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, listOf(['al-1']), LIVE_ALIAS])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/identity/entity-alias/id?list=true`)
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-1`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe(`alias:${KEY}`)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a DR-secondary node as reachable', async () => {
    const fetchStub = recordFetch([{ status: 472, body: {} }, TOKEN_OK, listOf(['al-1']), LIVE_ALIAS])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].passed).toBe(true)
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

      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch(/not initialized/i)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the token check when Vault rejects the token, without echoing it', async () => {
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN, listOf(['al-1']), LIVE_ALIAS])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[1].name).toBe('vault_token')
      expect(result.checks[1].passed).toBe(false)
      expect(result.checks[1].message).toMatch(/rejected the token/i)
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-alias check when the managed alias is no longer listed', async () => {
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      listOf(['al-9']),
      { status: 200, body: { data: { id: 'al-9', name: 'bob', mount_accessor: ACCESSOR } } },
    ])
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

  it('fails the per-alias check when the whole alias store is empty', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, NOT_FOUND])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not present/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the alias LIST errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to list entity aliases/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })
})
