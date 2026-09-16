import deploy, { type MountRollbackEntry } from '../deploy'
import type { LiveMount } from '../validate'
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

const NO_MOUNTS = { status: 200, body: { data: {} } }

function liveMounts(map: Record<string, LiveMount>) {
  return { status: 200, body: { data: map } }
}

function canvasWith(mounts: Array<Record<string, unknown>>) {
  return makeCanvas(
    mounts.map((fields, i) => ({ name: `Engine ${i + 1}`, fields })),
    'secret-mounts',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): MountRollbackEntry[] {
  return (result.rollbackData as { previousState?: MountRollbackEntry[] })?.previousState ?? []
}

function createdPaths(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdPaths?: string[] })?.createdPaths ?? []
}

describe('Vault Secret Mounts Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }]), { token: null }),
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
        makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }]), { hostname: '' }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NO_MOUNTS, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }])))

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

  it('mounts an engine that does not exist yet and records it as created', async () => {
    const fetchStub = recordFetch([NO_MOUNTS, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            {
              path: 'kv/prod',
              type: 'KV',
              description: 'Prod secrets',
              kvVersion: '2',
              defaultLeaseTtl: '768h',
            },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [list, enable] = fetchStub.calls
      expect(list.method).toBe('GET')
      expect(list.url).toBe(`${VAULT_BASE}/sys/mounts`)
      expect(enable.method).toBe('POST')
      expect(enable.url).toBe(`${VAULT_BASE}/sys/mounts/kv/prod`)
      expect(JSON.parse(enable.body)).toEqual({
        type: 'kv',
        description: 'Prod secrets',
        // options.version can only be set at enable time.
        options: { version: '2' },
        config: { default_lease_ttl: '768h' },
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].path).toBe('kv/prod')
      expect(entries[0].priorTune).toBeUndefined()
      expect(createdPaths(result)).toEqual(['kv/prod'])
      expect((result.artifacts as { createdMounts: string[] }).createdMounts).toEqual(['kv/prod'])
    } finally {
      fetchStub.restore()
    }
  })

  it('tunes a mount that already exists and never re-issues the enable call', async () => {
    const fetchStub = recordFetch([
      liveMounts({ 'secret/': { type: 'kv', description: 'old desc', options: { version: '2' } } }),
      { status: 200, body: { data: { default_lease_ttl: 2764800, max_lease_ttl: 2764800 } } },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { path: 'secret', type: 'kv', description: 'New desc', maxLeaseTtl: '8760h' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(3)

      const [, read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/mounts/secret/tune`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/mounts/secret/tune`)
      expect(JSON.parse(write.body)).toEqual({ max_lease_ttl: '8760h', description: 'New desc' })

      // Nothing may POST the bare mount path — that would be a second enable.
      const enables = fetchStub.calls.filter(
        (c) => c.method === 'POST' && c.url === `${VAULT_BASE}/sys/mounts/secret`,
      )
      expect(enables).toHaveLength(0)
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('captures the prior tuning and description of a mount it adopts', async () => {
    const fetchStub = recordFetch([
      liveMounts({ 'secret/': { type: 'kv', description: 'set by hand' } }),
      { status: 200, body: { data: { default_lease_ttl: 2764800, max_lease_ttl: 31536000 } } },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'secret', type: 'kv', description: 'Managed' }])),
      )

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      // Vault echoes TTLs as seconds numbers; they are stored as strings.
      expect(entries[0].priorTune).toEqual({
        default_lease_ttl: '2764800',
        max_lease_ttl: '31536000',
        description: 'set by hand',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a mount with no tuning body as having no prior TTLs', async () => {
    const fetchStub = recordFetch([
      liveMounts({ 'secret/': { type: 'kv' } }),
      NOT_FOUND,
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }])))

      expect(result.success).toBe(true)
      expect(rollbackEntries(result)[0].priorTune).toEqual({
        default_lease_ttl: undefined,
        max_lease_ttl: undefined,
        description: '',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses a type change and never unmounts the engine holding the data', async () => {
    const fetchStub = recordFetch([liveMounts({ 'secret/': { type: 'kv' } })])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'secret', type: 'transit' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/immutable/)
      expect(result.message).toMatch(/permanently destroys all secrets/)
      // One list, then a refusal — no DELETE, no re-enable.
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
      expect((result.artifacts as { deployedMounts: string[] }).deployedMounts).toEqual([])
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('succeeds with a loud warning when the live KV version cannot be converged', async () => {
    const fetchStub = recordFetch([
      liveMounts({ 'secret/': { type: 'kv', options: { version: 1 } } }),
      NOT_FOUND,
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'secret', type: 'kv', kvVersion: '2' }])),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/WARNING/)
      expect(result.message).toMatch(/KV v1 but the configuration wants v2/)
      expect(result.message).toMatch(/cannot be changed by tuning/)
      // The tune body must not smuggle a version change in.
      expect(JSON.parse(fetchStub.calls[2].body).options).toBeUndefined()
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the enable', async () => {
    const fetchStub = recordFetch([NO_MOUNTS, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to enable secret engine/)
      expect(result.message).toMatch(/permission denied/)
      // The enable failed, so nothing may be claimed as created.
      expect(createdPaths(result)).toEqual([])
      expect(rollbackEntries(result)).toHaveLength(0)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the mount list fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'secret', type: 'kv' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list secret engine mounts/)
      expect((result.artifacts as { deployedMounts: string[] }).deployedMounts).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later mount fails', async () => {
    const fetchStub = recordFetch([NO_MOUNTS, NO_CONTENT, NO_MOUNTS, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { path: 'first', type: 'kv' },
            { path: 'second', type: 'transit' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2/)
      // The first mount really exists now — rollback must know about it.
      expect((result.artifacts as { deployedMounts: string[] }).deployedMounts).toEqual(['first'])
      expect(createdPaths(result)).toEqual(['first'])
      expect(rollbackEntries(result)).toHaveLength(1)
      expect(rollbackEntries(result)[0].existed).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('collapses a messy path into the canonical mount identity', async () => {
    const fetchStub = recordFetch([NO_MOUNTS, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ path: '/kv//prod/', type: 'kv' }])))

      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/mounts/kv/prod`)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no path or no type without touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: '', type: 'kv' }, { path: 'secret' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
