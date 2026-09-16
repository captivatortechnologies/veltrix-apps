import rollback from '../rollback'
import type { AllowedReferrerRollbackEntry } from '../deploy'
import { API_URL, LOGON, ok, pvwaError, recordFetch, rollbackContext, vendorCalls } from '../../lib/__tests__/fakePvwa'

const ADDED: AllowedReferrerRollbackEntry = {
  key: 'https://portal.corp.example.com',
  label: 'https://portal.corp.example.com',
  existed: false,
  id: '3',
}

const PRE_EXISTING: AllowedReferrerRollbackEntry = {
  key: 'https://legacy.corp.example.com',
  label: 'https://legacy.corp.example.com',
  existed: true,
  id: '1',
}

const REFERRERS_URL = `${API_URL}/Configuration/AccessRestriction/AllowedReferrers`

describe('CyberArk Allowed Referrers Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [ADDED] }, { credential: null }))

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

  it('deletes only the entries this deploy added', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [PRE_EXISTING, ADDED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${REFERRERS_URL}/3`)
      expect(result.success).toBe(true)
      expect(result.message).toMatch('2 of 2')
    } finally {
      fake.restore()
    }
  })

  it('treats an already-removed entry (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Referrer not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [ADDED] }))

      expect(result.success).toBe(true)
      expect(result.message.includes('could not be confirmed removed')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('warns instead of failing when the unverified delete endpoint rejects', async () => {
    const fake = recordFetch([LOGON, pvwaError(405, 'Method not allowed')])
    try {
      const result = await rollback(rollbackContext({ previousState: [ADDED] }))

      // Delete is documented as best-effort: it reports what may be left behind
      // rather than failing the whole rollback.
      expect(result.success).toBe(true)
      expect(result.message).toMatch('could not be confirmed removed')
      expect(result.message).toMatch('Method not allowed')
      // The entry is not counted as reverted — the operator is told 0 of 1.
      expect(result.message).toMatch('Rolled back 0 of 1')
    } finally {
      fake.restore()
    }
  })

  it('reports an added entry whose id was never captured as possibly left behind', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(rollbackContext({ previousState: [{ ...ADDED, id: undefined }] }))

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
      expect(result.message).toMatch('could not be confirmed removed')
      expect(result.message).toMatch('https://portal.corp.example.com')
    } finally {
      fake.restore()
    }
  })
})
