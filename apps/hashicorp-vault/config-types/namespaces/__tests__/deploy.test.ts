import deploy, { type NamespaceRollbackEntry } from '../deploy'
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

const METADATA = '{"team":"platform"}'

function canvasWith(namespaces: Array<Record<string, unknown>>) {
  return makeCanvas(
    namespaces.map((fields, i) => ({ name: `Namespace ${i + 1}`, fields })),
    'namespaces',
  )
}

function live(customMetadata?: Record<string, string>) {
  return { status: 200, body: { data: { id: 'ns1', path: 'team-a/', custom_metadata: customMetadata } } }
}

function rollbackEntries(result: { rollbackData?: unknown }): NamespaceRollbackEntry[] {
  return (result.rollbackData as { previousState?: NamespaceRollbackEntry[] })?.previousState ?? []
}

function createdPaths(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdPaths?: string[] })?.createdPaths ?? []
}

describe('Vault Namespaces Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'team-a' }]), { token: null }),
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
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }]), { hostname: '' }))

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
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }])))

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

  it('creates an absent namespace with a plain JSON POST', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'team-a', customMetadataJson: METADATA }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, create] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      expect(read.headers['Content-Type']).toBe('application/json')
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      // Only the merge patch below uses the RFC 7396 content type.
      expect(create.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(create.body)).toEqual({ custom_metadata: { team: 'platform' } })

      expect(rollbackEntries(result)).toEqual([{ path: 'team-a', existed: false }])
      expect(createdPaths(result)).toEqual(['team-a'])
      expect((result.artifacts as { deployedNamespaces: string[] }).deployedNamespaces).toEqual([
        'team-a (created)',
      ])
    } finally {
      fetchStub.restore()
    }
  })

  it('creates with an empty body when no metadata is declared', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }])))

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({})
    } finally {
      fetchStub.restore()
    }
  })

  it('converges an existing namespace with a real RFC 7396 JSON merge patch', async () => {
    const fetchStub = recordFetch([live({ team: 'old', legacy: 'x' }), NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'team-a', customMetadataJson: METADATA }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const patch = fetchStub.calls[1]
      expect(patch.method).toBe('PATCH')
      expect(patch.url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      // The one place in this app that speaks merge-patch — lib/vault.ts sets it.
      expect(patch.headers['Content-Type']).toBe('application/merge-patch+json')
      // A merge patch leaves untouched keys alone, so a dropped key must be
      // explicitly nulled or it lingers forever.
      expect(JSON.parse(patch.body)).toEqual({
        custom_metadata: { team: 'platform', legacy: null },
      })

      expect((result.artifacts as { deployedNamespaces: string[] }).deployedNamespaces).toEqual([
        'team-a (updated)',
      ])
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('captures the prior metadata verbatim before patching', async () => {
    const fetchStub = recordFetch([live({ team: 'old', legacy: 'x' }), NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'team-a', customMetadataJson: METADATA }])),
      )

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].priorCustomMetadata).toEqual({ team: 'old', legacy: 'x' })
    } finally {
      fetchStub.restore()
    }
  })

  it('skips the write entirely when there is no metadata on either side', async () => {
    const fetchStub = recordFetch([live()])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      // Still recorded as touched so rollback can restore its empty metadata.
      expect(rollbackEntries(result)[0].existed).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes an authored path and addresses nested namespaces by full path', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: '/team-a/' }, { path: 'team-a/dev' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a/dev`)
    } finally {
      fetchStub.restore()
    }
  })

  it('explains the Enterprise requirement when the create returns 404', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NOT_FOUND])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault Enterprise/)
      expect(rollbackEntries(result)).toEqual([])
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read is rejected', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: 'team-a' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read namespace "team-a"/)
      expect(result.message).toMatch(/permission denied/)
      expect((result.artifacts as { deployedNamespaces: string[] }).deployedNamespaces).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the merge patch is rejected', async () => {
    const fetchStub = recordFetch([live({ team: 'old' }), FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'team-a', customMetadataJson: METADATA }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to update namespace "team-a"/)
      // The prior metadata was captured before the write, so rollback still works.
      expect(rollbackEntries(result)[0].priorCustomMetadata).toEqual({ team: 'old' })
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later namespace fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: 'first' }, { path: 'second' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 namespace/)
      expect((result.artifacts as { deployedNamespaces: string[] }).deployedNamespaces).toEqual([
        'first (created)',
      ])
      // Only the namespace that was really created may be destroyed on rollback.
      expect(rollbackEntries(result)).toEqual([{ path: 'first', existed: false }])
      expect(createdPaths(result)).toEqual(['first'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no path', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ path: '' }, {}])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
