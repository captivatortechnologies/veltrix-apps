import rollback from '../rollback'
import type { AccountRollbackEntry } from '../deploy'
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

const CREATED: AccountRollbackEntry = {
  key: '["svc-sql","app-prod"]',
  label: 'svc-sql @ App-Prod',
  existed: false,
  id: '77_3',
}

const UPDATED: AccountRollbackEntry = {
  key: '["svc-legacy","app-prod"]',
  label: 'svc-legacy @ App-Prod',
  existed: true,
  id: '88_1',
  prior: {
    address: 'old-sql01.corp.example.com',
    userName: 'svc_legacy',
    automaticManagementEnabled: false,
    manualManagementReason: 'rotated by the DBA team',
    platformAccountProperties: { Port: '1433' },
  },
}

describe('CyberArk Accounts Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }, { credential: null }))

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

  it('deletes an account this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Accounts/77_3`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the prior non-secret fields of an account this deploy updated', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const patch = vendorCalls(fake.calls)[0]
      expect(patch.method).toBe('PATCH')
      expect(patch.url).toBe(`${API_URL}/Accounts/88_1`)

      const ops = bodyOf(patch) as Array<{ op: string; path: string; value: unknown }>
      expect(ops).toEqual([
        { op: 'replace', path: '/address', value: 'old-sql01.corp.example.com' },
        { op: 'replace', path: '/userName', value: 'svc_legacy' },
        { op: 'replace', path: '/secretManagement/automaticManagementEnabled', value: false },
        { op: 'add', path: '/platformAccountProperties/Port', value: '1433' },
      ])
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Accounts/88_1`)
      expect(calls[1].url).toBe(`${API_URL}/Accounts/77_3`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted account (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Account not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the delete', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'You are not authorized to delete accounts')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('You are not authorized to delete accounts')
    } finally {
      fake.restore()
    }
  })

  it('makes no call for an updated account whose prior fields were all unset', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({ previousState: [{ ...UPDATED, prior: {} }] }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
