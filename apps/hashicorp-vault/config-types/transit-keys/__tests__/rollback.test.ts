import rollback from '../rollback'
import type { TransitKeyRollbackEntry } from '../deploy'
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
  previousState: TransitKeyRollbackEntry[] | undefined,
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'transit-keys'),
    previousState === undefined ? {} : { previousState, createdKeys: [] },
    o,
  )
}

const CREATED_BY_DEPLOY: TransitKeyRollbackEntry = {
  mount: 'transit',
  name: 'app',
  existed: false,
}

describe('Vault Transit Keys Rollback Handler', () => {
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

  it('enables deletion before destroying a key the deploy created, and says so', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [allow, destroy] = fetchStub.calls
      expect(allow.method).toBe('POST')
      expect(allow.url).toBe(`${VAULT_BASE}/transit/keys/app/config`)
      expect(JSON.parse(allow.body)).toEqual({ deletion_allowed: true })
      expect(destroy.method).toBe('DELETE')
      expect(destroy.url).toBe(`${VAULT_BASE}/transit/keys/app`)
      expect(destroy.headers['X-Vault-Token']).toBe(VAULT_TOKEN)

      expect(result.message).toMatch(/PERMANENTLY DESTROYS their key material/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('never destroys a key that pre-existed the deploy', async () => {
    const fetchStub = recordFetch([])
    try {
      // existed:true and nothing captured — deploy only adopted this key, so no
      // deletion_allowed escalation and above all no DELETE.
      const result = await rollback(ctx([{ mount: 'transit', name: 'app', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(String(result.message).includes('DESTROYS')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the prior tunables of a key the deploy only configured', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            mount: 'transit',
            name: 'app',
            existed: true,
            priorConfig: {
              deletion_allowed: false,
              min_decryption_version: 1,
              min_encryption_version: 0,
              auto_rotate_period: 0,
            },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/transit/keys/app/config`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        deletion_allowed: false,
        min_decryption_version: 1,
        min_encryption_version: 0,
        auto_rotate_period: 0,
      })
      expect(fetchStub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('leaves write-once flags out of the restore body', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([
          { mount: 'transit', name: 'app', existed: true, priorConfig: { deletion_allowed: true } },
        ]),
      )

      const body = JSON.parse(fetchStub.calls[0].body)
      // Vault cannot revert these, so a restore must not try.
      expect(body.exportable).toBeUndefined()
      expect(body.allow_plaintext_backup).toBeUndefined()
      expect(body).toEqual({ deletion_allowed: true })
    } finally {
      fetchStub.restore()
    }
  })

  it('tolerates a 404 while enabling deletion and still removes the key', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NOT_FOUND])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].method).toBe('DELETE')
    } finally {
      fetchStub.restore()
    }
  })

  it('does not attempt the delete when Vault refuses to enable deletion', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to enable deletion for transit key/)
      expect(fetchStub.calls).toHaveLength(1)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete transit key/)
      expect(result.message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the config restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { mount: 'transit', name: 'app', existed: true, priorConfig: { deletion_allowed: false } },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore configuration for transit key/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { mount: 'transit', name: 'one', existed: false },
          { mount: 'transit', name: 'two', existed: false },
          { mount: 'transit', name: 'three', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 3/)
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })
})
