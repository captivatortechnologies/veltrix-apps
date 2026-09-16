import rollback from '../rollback'
import type { PolicyRollbackEntry } from '../deploy'
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

const PRIOR_HCL = 'path "secret/data/app/*" {\n  capabilities = ["read"]\n}'

function ctx(previousState: PolicyRollbackEntry[] | undefined, o: { token?: string | null } = {}) {
  return makeRollbackContext(
    makeCanvas([], 'policies'),
    previousState === undefined ? {} : { previousState, createdNames: [] },
    o,
  )
}

describe('Vault ACL Policies Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'app-read', existed: false }], { token: null }))

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

  it('deletes a policy the deploy created', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ name: 'app-read', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ name: 'app-read', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/app-read/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the prior HCL body for a policy the deploy updated', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([{ name: 'app-read', existed: true, priorPolicy: PRIOR_HCL }]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
      expect(JSON.parse(fetchStub.calls[0].body).policy).toBe(PRIOR_HCL)
    } finally {
      fetchStub.restore()
    }
  })

  it('never deletes the built-in default policy', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'default', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('never touches the root policy', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'root', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ name: 'app-read', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([{ name: 'app-read', existed: true, priorPolicy: PRIOR_HCL }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore policy/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { name: 'first', existed: false },
          { name: 'second', existed: false },
          { name: 'third', existed: false },
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
