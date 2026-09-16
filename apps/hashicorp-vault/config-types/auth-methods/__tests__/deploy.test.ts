import deploy, { type AuthMethodRollbackEntry } from '../deploy'
import type { LiveAuthMethod } from '../validate'
import {
  FORBIDDEN,
  NO_CONTENT,
  NOT_FOUND,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const NO_METHODS = { status: 200, body: { data: {} } }

function liveMethods(map: Record<string, LiveAuthMethod>) {
  return { status: 200, body: { data: map } }
}

function canvasWith(methods: Array<Record<string, unknown>>) {
  return makeCanvas(
    methods.map((fields, i) => ({ name: `Method ${i + 1}`, fields })),
    'auth-methods',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): AuthMethodRollbackEntry[] {
  return (result.rollbackData as { previousState?: AuthMethodRollbackEntry[] })?.previousState ?? []
}

function createdPaths(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdPaths?: string[] })?.createdPaths ?? []
}

describe('Vault Auth Methods Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }]), { token: null }),
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
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }]), { hostname: '' }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }])),
      )

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

  it('enables a method that is not mounted yet and records it as created', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            {
              path: 'userpass',
              type: 'userpass',
              description: 'Local users',
              defaultLeaseTtl: '768h',
              maxLeaseTtl: '8760h',
              listingVisibility: 'unauth',
            },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [list, enable] = fetchStub.calls
      expect(list.method).toBe('GET')
      expect(list.url).toBe(`${VAULT_BASE}/sys/auth`)
      expect(enable.method).toBe('POST')
      expect(enable.url).toBe(`${VAULT_BASE}/sys/auth/userpass`)
      expect(JSON.parse(enable.body)).toEqual({
        type: 'userpass',
        description: 'Local users',
        // Tunables ride nested under `config` at enable time.
        config: { default_lease_ttl: '768h', max_lease_ttl: '8760h', listing_visibility: 'unauth' },
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].type).toBe('userpass')
      expect(entries[0].priorTune).toBeUndefined()
      expect(createdPaths(result)).toEqual(['userpass'])
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps token_type out of the enable body and applies it in a separate tune call', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([{ path: 'approle', type: 'approle', tokenType: 'batch' }]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(3)

      const enableBody = JSON.parse(fetchStub.calls[1].body)
      expect(enableBody.token_type).toBeUndefined()
      expect(enableBody.config).toBeUndefined()

      const tune = fetchStub.calls[2]
      expect(tune.method).toBe('POST')
      expect(tune.url).toBe(`${VAULT_BASE}/sys/auth/approle/tune`)
      // Only token_type — the enable body already carried everything else.
      expect(JSON.parse(tune.body)).toEqual({ token_type: 'batch' })
    } finally {
      fetchStub.restore()
    }
  })

  it('tunes a method that already exists and captures its prior tuning verbatim', async () => {
    const priorTune = {
      default_lease_ttl: 2764800,
      max_lease_ttl: 2764800,
      description: 'set by hand',
      token_type: 'default',
      listing_visibility: 'hidden',
    }
    const fetchStub = recordFetch([
      liveMethods({ 'userpass/': { type: 'userpass' } }),
      { status: 200, body: { data: priorTune } },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { path: 'userpass', type: 'userpass', description: 'Local users', maxLeaseTtl: '8760h' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(3)

      const [, read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/auth/userpass/tune`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/auth/userpass/tune`)
      // Tune fields are FLAT, and description is always sent so clearing converges.
      expect(JSON.parse(write.body)).toEqual({
        description: 'Local users',
        max_lease_ttl: '8760h',
      })

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].priorTune).toEqual(priorTune)
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('never re-enables an existing mount — an existing path takes the tune path only', async () => {
    const fetchStub = recordFetch([
      liveMethods({ 'userpass/': { type: 'userpass' } }),
      NOT_FOUND,
      NO_CONTENT,
    ])
    try {
      await deploy(makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }])))

      // The bare enable URL must never be POSTed for a path Vault already holds.
      const enables = fetchStub.calls.filter(
        (c) => c.method === 'POST' && c.url === `${VAULT_BASE}/sys/auth/userpass`,
      )
      expect(enables).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses to change an immutable type and writes nothing', async () => {
    const fetchStub = recordFetch([liveMethods({ 'userpass/': { type: 'ldap' } })])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/IMMUTABLE/)
      // Only the list happened — no disable, no re-enable, no tune.
      expect(fetchStub.calls).toHaveLength(1)
      expect((result.artifacts as { deployedAuthMethods: string[] }).deployedAuthMethods).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the enable', async () => {
    const fetchStub = recordFetch([NO_METHODS, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/permission denied/)
      // The enable failed, so nothing may be claimed as created.
      expect(createdPaths(result)).toEqual([])
      expect(rollbackEntries(result)).toHaveLength(0)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('still records a newly enabled mount when the follow-up token_type tune fails', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'approle', type: 'approle', tokenType: 'batch' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/failed to set token_type=batch/)
      // The mount really was enabled — rollback must be able to disable it again.
      expect(createdPaths(result)).toEqual(['approle'])
      expect(rollbackEntries(result)[0].existed).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the mount list fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'userpass', type: 'userpass' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list auth methods/)
      expect(result.message).toMatch(/internal error/)
      expect((result.artifacts as { deployedAuthMethods: string[] }).deployedAuthMethods).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later method fails', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { path: 'first', type: 'userpass' },
            { path: 'second', type: 'approle' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2/)
      expect((result.artifacts as { deployedAuthMethods: string[] }).deployedAuthMethods).toEqual([
        'first (enabled userpass)',
      ])
      // Only the mount that was really enabled is offered for rollback.
      expect(createdPaths(result)).toEqual(['first'])
      expect(rollbackEntries(result)).toHaveLength(1)
      expect(rollbackEntries(result)[0].path).toBe('first')
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a slash-wrapped path into the mount identity', async () => {
    const fetchStub = recordFetch([NO_METHODS, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(canvasWith([{ path: '/kubernetes/prod/', type: 'kubernetes' }])),
      )

      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/auth/kubernetes/prod`)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no path or no type', async () => {
    const fetchStub = recordFetch([NO_METHODS])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: '', type: 'userpass' }, { path: 'approle' }])),
      )

      expect(result.success).toBe(true)
      // Only the list — nothing was enabled or tuned.
      expect(fetchStub.calls).toHaveLength(1)
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
