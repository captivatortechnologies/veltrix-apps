import rollback from '../rollback'
import type { SafeMemberRollbackEntry } from '../deploy'
import { SAFE_MEMBER_PERMISSIONS } from '../validate'
import {
  API_URL,
  LOGON,
  bodyOf,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GRANTED: SafeMemberRollbackEntry = {
  key: '["app-prod","appowners"]',
  label: 'AppOwners @ App-Prod',
  safeUrlId: 'App-Prod',
  memberName: 'AppOwners',
  existed: false,
}

const WIDENED: SafeMemberRollbackEntry = {
  key: '["app-prod","appreaders"]',
  label: 'AppReaders @ App-Prod',
  safeUrlId: 'App-Prod',
  memberName: 'AppReaders',
  existed: true,
  prior: { permissions: ['listAccounts'], membershipExpiration: 1_760_000_000 },
}

describe('CyberArk Safe Members Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [GRANTED] }, { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('refuses when the deployment recorded no previous state', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('revokes access this deploy granted', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [GRANTED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Safes/App-Prod/Members/AppOwners`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('narrows a widened member back to exactly its prior permissions', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [WIDENED] }))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/Safes/App-Prod/Members/AppReaders`)

      const body = bodyOf(restore) as { permissions: Record<string, boolean>; membershipExpirationDate: number }
      expect(Object.keys(body.permissions)).toHaveLength(SAFE_MEMBER_PERMISSIONS.length)
      expect(body.permissions.listAccounts).toBe(true)
      // Anything the deploy added must come back off, explicitly.
      expect(body.permissions.manageSafe).toBe(false)
      expect(body.permissions.retrieveAccounts).toBe(false)
      expect(body.membershipExpirationDate).toBe(1_760_000_000)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [GRANTED, WIDENED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Safes/App-Prod/Members/AppReaders`)
      expect(calls[1].url).toBe(`${API_URL}/Safes/App-Prod/Members/AppOwners`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-revoked member (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Member not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [GRANTED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the revoke', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'You do not have Manage Safe Members')])
    try {
      const result = await rollback(rollbackContext({ previousState: [GRANTED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('You do not have Manage Safe Members')
    } finally {
      fake.restore()
    }
  })

  it('leaves an updated member alone when the deploy captured no prior grant', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({
          previousState: [{ ...WIDENED, prior: undefined }],
        }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
