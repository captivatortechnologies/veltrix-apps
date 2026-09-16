import healthCheck from '../healthCheck'
import type { LiveTransitKey } from '../validate'
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

const AES = 'aes256-gcm96'

function liveKey(data: LiveTransitKey) {
  return { status: 200, body: { data } }
}

function ctx(
  keys: Array<Record<string, unknown>> = [{ mount: 'transit', name: 'app', type: AES }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeHealthCheckContext(
    makeCanvas(
      keys.map((fields, i) => ({ name: `Key ${i + 1}`, fields })),
      'transit-keys',
    ),
    o,
  )
}

describe('Vault Transit Keys Health Check Handler', () => {
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

  it('scores 100 when Vault is active, the token is accepted and the key is present', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveKey({ type: AES })])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/transit/keys/app`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('key:transit/app')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('never asks Vault for the key material', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveKey({ type: AES })])
    try {
      await healthCheck(ctx())

      // Export is the only route that can reveal material; it must never appear.
      expect(fetchStub.matching('/export')).toHaveLength(0)
      for (const call of fetchStub.calls) {
        expect(call.method).toMatch(/^GET$/)
      }
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, liveKey({ type: AES })])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/reachable and unsealed/)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a DR secondary as reachable', async () => {
    const fetchStub = recordFetch([{ status: 472, body: {} }, TOKEN_OK, liveKey({ type: AES })])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a performance standby as reachable', async () => {
    const fetchStub = recordFetch([{ status: 473, body: {} }, TOKEN_OK, liveKey({ type: AES })])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[0].passed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails on a sealed Vault and stops before the token and key probes', async () => {
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
    const fetchStub = recordFetch([HEALTHY, FORBIDDEN, liveKey({ type: AES })])
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

  it('fails the per-key check when a managed key has vanished', async () => {
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

  it('fails the per-key check when the key was recreated with a different type', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveKey({ type: 'rsa-4096' })])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.checks[2].message).toMatch(/is type "rsa-4096", expected "aes256-gcm96"/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a failed check rather than throwing when the key read errors', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/Failed to read transit key/)
      expect(result.checks[2].message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores the mix when one of two managed keys is gone', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, liveKey({ type: AES }), NOT_FOUND])
    try {
      const result = await healthCheck(
        ctx([
          { mount: 'transit', name: 'app', type: AES },
          { mount: 'transit', name: 'db', type: AES },
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

  it('checks nothing beyond the cluster when the canvas declares no key', async () => {
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
