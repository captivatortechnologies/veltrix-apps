import driftDetect from '../driftDetect'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

/** A live role matching the canvas defaults every managed boolean is compared against. */
const DEFAULTS: Record<string, unknown> = {
  key_usage: [],
  allowed_domains: [],
  allow_bare_domains: false,
  allow_subdomains: false,
  allow_glob_domains: false,
  allow_wildcard_certificates: true,
  allow_localhost: true,
  allow_any_name: false,
  enforce_hostnames: true,
  allow_ip_sans: true,
  server_flag: true,
  client_flag: true,
  code_signing_flag: false,
  require_cn: true,
  use_csr_common_name: true,
  no_store: false,
  generate_lease: false,
}

function liveRole(overrides: Record<string, unknown> = {}) {
  return { status: 200, body: { data: { ...DEFAULTS, ...overrides } } }
}

function ctx(
  roles: Array<Record<string, unknown>> = [{ mount: 'pki', name: 'web' }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeDriftContext(
    makeCanvas(
      roles.map((fields, i) => ({ name: `Role ${i + 1}`, fields })),
      'pki-roles',
    ),
    o,
  )
}

describe('Vault PKI Roles Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(undefined, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(undefined, { hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when every managed field matches', async () => {
    const fetchStub = recordFetch([liveRole()])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/pki/roles/web`)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores list ordering — a reordered allowed_domains is not drift', async () => {
    const fetchStub = recordFetch([liveRole({ allowed_domains: ['a.example.com', 'b.example.com'] })])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'pki', name: 'web', allowedDomains: ['b.example.com', 'a.example.com'] }]),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a numeric key size Vault returns as a string', async () => {
    const fetchStub = recordFetch([liveRole({ key_bits: '2048' })])
    try {
      const result = await driftDetect(ctx([{ mount: 'pki', name: 'web', keyBits: 2048 }]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores a live value for a scalar the canvas does not manage', async () => {
    const fetchStub = recordFetch([liveRole({ ttl: '8760h', key_type: 'ec' })])
    try {
      const result = await driftDetect(ctx())

      // This app never writes an unauthored ttl/key_type, so it never reports one.
      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a role that has been deleted out of band as critical', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('pki/web')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('names a loosened issuance constraint', async () => {
    const fetchStub = recordFetch([liveRole({ allow_any_name: true })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('pki/web.allowAnyName')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('names a widened allowed-domain list', async () => {
    const fetchStub = recordFetch([
      liveRole({ allowed_domains: ['example.com', 'evil.example.net'] }),
    ])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'pki', name: 'web', allowedDomains: ['example.com'] }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('pki/web.allowedDomains')
      expect(result.diffs[0].expected).toBe('example.com')
      expect(result.diffs[0].actual).toBe('evil.example.net,example.com')
    } finally {
      fetchStub.restore()
    }
  })

  it('names a drifted TTL the canvas does manage', async () => {
    const fetchStub = recordFetch([liveRole({ ttl: '8760h' })])
    try {
      const result = await driftDetect(ctx([{ mount: 'pki', name: 'web', ttl: '72h' }]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('pki/web.ttl')
      expect(result.diffs[0].expected).toBe('72h')
      expect(result.diffs[0].actual).toBe('8760h')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a missing managed field as an empty live value rather than skipping it', async () => {
    const fetchStub = recordFetch([liveRole({ key_type: undefined })])
    try {
      const result = await driftDetect(ctx([{ mount: 'pki', name: 'web', keyType: 'rsa' }]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('pki/web.keyType')
      expect(result.diffs[0].expected).toBe('rsa')
      expect(result.diffs[0].actual).toBe('')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('pki/web')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(String(result.diffs[0].actual)).toMatch(/permission denied/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining roles after one errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN, liveRole()])
    try {
      const result = await driftDetect(
        ctx([
          { mount: 'pki', name: 'web' },
          { mount: 'pki', name: 'api' },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('pki/web')
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
