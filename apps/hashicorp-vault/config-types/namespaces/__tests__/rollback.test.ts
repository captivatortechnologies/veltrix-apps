import rollback from '../rollback'
import type { NamespaceRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeRollbackContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function ctx(
  previousState: NamespaceRollbackEntry[] | undefined,
  o: { token?: string | null } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'namespaces'),
    previousState === undefined ? {} : { previousState, createdPaths: [] },
    o,
  )
}

function live(customMetadata?: Record<string, string>) {
  return { status: 200, body: { data: { path: 'team-a/', custom_metadata: customMetadata } } }
}

describe('Vault Namespaces Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: false }], { token: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure when there is no previous state to restore', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure for an empty previous state rather than claiming success', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('deletes a namespace the deploy created and warns that it is destructive', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/PERMANENTLY DESTROYS/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/team-a/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores prior metadata with a merge patch that nulls out what deploy added', async () => {
    const fetchStub = recordFetch([live({ team: 'platform', added: 'y' }), NO_CONTENT])
    try {
      const result = await rollback(
        ctx([{ path: 'team-a', existed: true, priorCustomMetadata: { team: 'old' } }]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[0].method).toBe('GET')

      const patch = fetchStub.calls[1]
      expect(patch.method).toBe('PATCH')
      expect(patch.url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
      expect(patch.headers['Content-Type']).toBe('application/merge-patch+json')
      expect(JSON.parse(patch.body)).toEqual({ custom_metadata: { team: 'old', added: null } })
    } finally {
      fetchStub.restore()
    }
  })

  it('never deletes a namespace that existed before the deploy', async () => {
    const fetchStub = recordFetch([live({ team: 'platform' }), NO_CONTENT])
    try {
      const result = await rollback(
        ctx([{ path: 'team-a', existed: true, priorCustomMetadata: { team: 'old' } }]),
      )

      expect(result.success).toBe(true)
      for (const call of fetchStub.calls) {
        expect(call.method).toMatch(/^(GET|PATCH)$/)
      }
    } finally {
      fetchStub.restore()
    }
  })

  it('does nothing for an updated namespace with no prior metadata to restore', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips the patch when the live metadata already equals the prior snapshot', async () => {
    const fetchStub = recordFetch([live()])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: true, priorCustomMetadata: {} }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ path: 'team-a', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete namespace "team-a"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the restore read is rejected', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([{ path: 'team-a', existed: true, priorCustomMetadata: { team: 'old' } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read namespace "team-a"/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the restore patch is rejected', async () => {
    const fetchStub = recordFetch([live({ team: 'platform' }), FORBIDDEN])
    try {
      const result = await rollback(
        ctx([{ path: 'team-a', existed: true, priorCustomMetadata: { team: 'old' } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore namespace "team-a"/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { path: 'first', existed: false },
          { path: 'second', existed: false },
          { path: 'third', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
