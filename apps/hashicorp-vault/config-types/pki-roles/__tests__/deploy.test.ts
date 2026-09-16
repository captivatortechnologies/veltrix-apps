import deploy, { type PkiRoleRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function liveRole(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

function canvasWith(roles: Array<Record<string, unknown>>) {
  return makeCanvas(
    roles.map((fields, i) => ({ name: `Role ${i + 1}`, fields })),
    'pki-roles',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): PkiRoleRollbackEntry[] {
  return (result.rollbackData as { previousState?: PkiRoleRollbackEntry[] })?.previousState ?? []
}

function createdKeys(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdKeys?: string[] })?.createdKeys ?? []
}

describe('Vault PKI Roles Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }]), { token: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }]), { hostname: '' }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('creates a role that does not exist and sends every issuance constraint it models', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            {
              mount: 'pki',
              name: 'web',
              ttl: '72h',
              maxTtl: '8760h',
              keyType: 'RSA',
              keyBits: 2048,
              keyUsage: ['DigitalSignature', 'KeyEncipherment'],
              allowedDomains: ['example.com'],
              allowSubdomains: true,
              notBeforeDuration: '30s',
              issuerRef: 'default',
            },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/pki/roles/web`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/pki/roles/web`)
      // Every boolean is sent explicitly so the canvas owns the whole policy.
      expect(JSON.parse(write.body)).toEqual({
        key_usage: ['DigitalSignature', 'KeyEncipherment'],
        allowed_domains: ['example.com'],
        allow_bare_domains: false,
        allow_subdomains: true,
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
        ttl: '72h',
        max_ttl: '8760h',
        key_type: 'rsa',
        key_bits: 2048,
        not_before_duration: '30s',
        issuer_ref: 'default',
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].priorBody).toBeUndefined()
      expect(createdKeys(result)).toEqual(['pki/web'])
      expect((result.artifacts as { createdRoles: string[] }).createdRoles).toEqual(['pki/web'])
    } finally {
      fetchStub.restore()
    }
  })

  it('captures the complete prior role verbatim before overwriting an existing one', async () => {
    const prior = {
      ttl: '24h',
      allowed_domains: ['old.example.com'],
      allow_any_name: true,
      // A field this canvas does not model — only a verbatim capture restores it.
      policy_identifiers: ['1.3.6.1.4.1.99'],
    }
    const fetchStub = recordFetch([liveRole(prior), NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'pki', name: 'web', ttl: '72h' }])),
      )

      expect(result.success).toBe(true)
      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].priorBody).toEqual(prior)
      expect(createdKeys(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('writes the same full role body whether the role existed or not', async () => {
    const createStub = recordFetch([NOT_FOUND, NO_CONTENT])
    let createdBody = ''
    try {
      await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))
      createdBody = createStub.calls[1].body
    } finally {
      createStub.restore()
    }

    const updateStub = recordFetch([liveRole({ allow_any_name: true }), NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))

      // A role write is a FULL REPLACE — adopting a role resets everything this
      // canvas models, so the update body must not inherit the live values.
      expect(updateStub.calls[1].body).toBe(createdBody)
      expect(JSON.parse(updateStub.calls[1].body).allow_any_name).toBe(false)
    } finally {
      updateStub.restore()
    }
  })

  it('drops an out-of-band field the canvas does not model from the write body', async () => {
    const fetchStub = recordFetch([
      liveRole({ policy_identifiers: ['1.3.6.1.4.1.99'], ou: ['Platform'] }),
      NO_CONTENT,
    ])
    try {
      await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))

      const body = JSON.parse(fetchStub.calls[1].body)
      expect(body.policy_identifiers).toBeUndefined()
      expect(body.ou).toBeUndefined()
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to write PKI role/)
      expect(result.message).toMatch(/permission denied/)
      expect((result.artifacts as { deployedRoles: string[] }).deployedRoles).toEqual([])
      // The entry is recorded before the write, so a half-applied write is still
      // revertible — deleting a role that was never created is a no-op 404.
      expect(createdKeys(result)).toEqual(['pki/web'])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the role read errors', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ mount: 'pki', name: 'web' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read PKI role/)
      expect(result.message).toMatch(/internal error/)
      // The read failed before anything was recorded or written.
      expect(createdKeys(result)).toEqual([])
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later role fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { mount: 'pki', name: 'web' },
            { mount: 'pki', name: 'api' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2/)
      // The first role really was written — rollback must know about it.
      expect((result.artifacts as { deployedRoles: string[] }).deployedRoles).toEqual(['pki/web'])
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].name).toBe('web')
    } finally {
      fetchStub.restore()
    }
  })

  it('collapses a messy mount path into the canonical role URL', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ mount: '/pki_int//', name: 'web' }])))

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/pki_int/roles/web`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/pki_int/roles/web`)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections missing a mount or a name without touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: '', name: 'web' }, { mount: 'pki' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
