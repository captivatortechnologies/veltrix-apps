import rollback from '../rollback'
import type { MountRollbackEntry } from '../deploy'
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
  previousState: MountRollbackEntry[] | undefined,
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'secret-mounts'),
    previousState === undefined ? {} : { previousState, createdPaths: [] },
    o,
  )
}

const CREATED_BY_DEPLOY: MountRollbackEntry = { path: 'secret', type: 'kv', existed: false }

describe('Vault Secret Mounts Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY], { token: null }))

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
      const result = await rollback(ctx([CREATED_BY_DEPLOY], { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
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

  it('unmounts an engine the deploy created and says the data was destroyed', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/mounts/secret`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/DESTRUCTIVE/)
      expect(result.message).toMatch(/PERMANENTLY DESTROYED all secrets/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('never unmounts an engine that pre-existed the deploy', async () => {
    const fetchStub = recordFetch([])
    try {
      // existed:true and nothing captured — adopting a mount must never let a
      // rollback delete it, which would destroy secrets this deploy never wrote.
      const result = await rollback(ctx([{ path: 'secret', type: 'kv', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(String(result.message).includes('DESTRUCTIVE')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores prior tuning instead of deleting a mount the deploy only tuned', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            path: 'secret',
            type: 'kv',
            existed: true,
            priorTune: {
              default_lease_ttl: '2764800',
              max_lease_ttl: '31536000',
              description: 'set by hand',
            },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/mounts/secret/tune`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        default_lease_ttl: '2764800',
        max_lease_ttl: '31536000',
        description: 'set by hand',
      })
      expect(fetchStub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('omits from the restore body any tunable Vault never reported', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([{ path: 'secret', type: 'kv', existed: true, priorTune: { description: '' } }]),
      )

      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({ description: '' })
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on unmount as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/secret/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the unmount', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to disable secret engine/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the tune restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([{ path: 'secret', type: 'kv', existed: true, priorTune: { description: 'old' } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore tuning/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { path: 'first', type: 'kv', existed: false },
          { path: 'second', type: 'kv', existed: false },
          { path: 'third', type: 'kv', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
