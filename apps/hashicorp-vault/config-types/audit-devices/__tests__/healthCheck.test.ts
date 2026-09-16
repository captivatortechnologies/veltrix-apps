import healthCheck from '../healthCheck'
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

const FILE_DEVICE = { path: 'file', type: 'file', filePath: '/var/log/vault-audit.log' }

function ctx(
  devices: Array<Record<string, unknown>> = [FILE_DEVICE],
  o: { token?: string | null } = {},
) {
  return makeHealthCheckContext(
    makeCanvas(
      devices.map((fields, i) => ({ name: `Device ${i + 1}`, fields })),
      'audit-devices',
    ),
    o,
  )
}

const LIVE_FILE = { status: 200, body: { data: { 'file/': { type: 'file' } } } }

describe('Vault Audit Devices Health Check Handler', () => {
  it('reports a zero score without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await healthCheck(ctx([FILE_DEVICE], { token: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('vault_credential')
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('scores 100 when Vault is active, the token is accepted and the device is mounted', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, LIVE_FILE])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/health`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/auth/token/lookup-self`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/audit`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.checks[2].name).toBe('audit:file')
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 429, body: { standby: true } }, TOKEN_OK, LIVE_FILE])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(true)
      expect(result.checks[0].message).toMatch(/HTTP 429/)
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a performance standby node as reachable and unsealed', async () => {
    const fetchStub = recordFetch([{ status: 473, body: {} }, TOKEN_OK, LIVE_FILE])
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
      // A sealed Vault cannot answer anything else — no further calls.
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
      expect(result.checks).toHaveLength(1)
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
      assertNoTokenLeak(result.checks)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails the per-device check when a managed device is no longer mounted', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, { status: 200, body: { data: {} } }])
    try {
      const result = await healthCheck(ctx())

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(67)
      expect(result.checks[2].name).toBe('audit:file')
      expect(result.checks[2].passed).toBe(false)
      expect(result.checks[2].message).toMatch(/is not enabled in Vault/)
    } finally {
      fetchStub.restore()
    }
  })

  it('turns a failed device listing into failed per-device checks, not a throw', async () => {
    const fetchStub = recordFetch([HEALTHY, TOKEN_OK, FORBIDDEN])
    try {
      const result = await healthCheck(
        ctx([FILE_DEVICE, { path: 'syslog', type: 'syslog', syslogTag: 'vault' }]),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(4)
      expect(result.score).toBe(50)
      expect(result.checks[2].message).toMatch(/Failed to list audit devices/)
      expect(result.checks[3].message).toMatch(/permission denied/)
      // One list call answers every device — the failure is not re-fetched.
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports the live backend type of a device that is present', async () => {
    const fetchStub = recordFetch([
      HEALTHY,
      TOKEN_OK,
      { status: 200, body: { data: { 'file/': { type: 'syslog' } } } },
    ])
    try {
      const result = await healthCheck(ctx())

      expect(result.checks[2].passed).toBe(true)
      expect(result.checks[2].message).toMatch(/type: syslog/)
    } finally {
      fetchStub.restore()
    }
  })
})
