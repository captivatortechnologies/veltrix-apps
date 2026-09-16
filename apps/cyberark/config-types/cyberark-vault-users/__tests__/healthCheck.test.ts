import healthCheck from '../healthCheck'
import {
  LOGON,
  healthContext,
  item,
  named,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const USERS = [item('User 1', { username: 'svc-backup' }), item('User 2', { username: 'svc-legacy' })]

describe('CyberArk Vault Users Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(USERS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared user is present', async () => {
    const fake = recordFetch([
      LOGON,
      named('Users', [{ id: 1, username: 'svc-backup' }, { id: 2, username: 'svc-legacy' }]),
    ])
    try {
      const result = await healthCheck(healthContext(USERS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific user that has gone missing', async () => {
    const fake = recordFetch([LOGON, named('Users', [{ id: 1, username: 'svc-backup' }])])
    try {
      const result = await healthCheck(healthContext(USERS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'user:svc-legacy')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(USERS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
