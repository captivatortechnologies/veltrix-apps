import rollback from '../rollback'
import type { MfaMethodRollbackEntry } from '../deploy'
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

function ctx(previousState: MfaMethodRollbackEntry[] | undefined, o: { token?: string | null } = {}) {
  return makeRollbackContext(
    makeCanvas([], 'mfa-methods'),
    previousState === undefined ? {} : { previousState, createdIds: [] },
    o,
  )
}

const createdTotp = (methodId?: string): MfaMethodRollbackEntry => ({
  methodName: 'authenticator',
  type: 'totp',
  existed: false,
  methodId,
})

describe('Vault Login MFA Methods Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([createdTotp('m-1')], { token: null }))

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

  it('deletes a method the deploy created, addressed by its generated id', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([createdTotp('m-1')]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-1`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/login-enforcement/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([createdTotp('m-1')]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/authenticator/)
    } finally {
      fetchStub.restore()
    }
  })

  it('cannot delete a created method whose generated id was never captured, and makes no call', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([createdTotp(undefined)]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(result.message.includes('WARNING')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the captured prior non-secret body for a method the deploy updated', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            methodName: 'authenticator',
            type: 'totp',
            existed: true,
            methodId: 'm-2',
            priorBody: { method_name: 'authenticator', issuer: 'Old Issuer', period: 60 },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-2`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        method_name: 'authenticator',
        issuer: 'Old Issuer',
        period: 60,
      })
      // totp has no secret, so the write-only caveat must not be reported.
      expect(result.message.includes('write-only')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('says plainly that a restored duo method keeps the secrets the rolled-back deploy set', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            methodName: 'duo-push',
            type: 'duo',
            existed: true,
            methodId: 'm-3',
            priorBody: { method_name: 'duo-push', api_hostname: 'api-old.duosecurity.com' },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/could NOT be restored/)
      expect(result.message).toMatch(/write-only/)
      // The restore replays only what was captured — no secret is invented.
      expect(fetchStub.calls[0].body.includes('secret_key')).toBe(false)
      expect(fetchStub.calls[0].body.includes('integration_key')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('leaves an updated method alone when no prior body was captured', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(
        ctx([{ methodName: 'authenticator', type: 'totp', existed: true, methodId: 'm-2' }]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([createdTotp('m-1')]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete MFA method "authenticator" \(totp\)/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await rollback(
        ctx([
          {
            methodName: 'authenticator',
            type: 'totp',
            existed: true,
            methodId: 'm-2',
            priorBody: { method_name: 'authenticator' },
          },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore MFA method "authenticator" \(totp\)/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { ...createdTotp('m-1'), methodName: 'first' },
          { ...createdTotp('m-2'), methodName: 'second' },
          { ...createdTotp('m-3'), methodName: 'third' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3 method/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
