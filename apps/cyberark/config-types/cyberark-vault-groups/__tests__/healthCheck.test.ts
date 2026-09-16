import healthCheck from '../healthCheck'
import {
  LOGON,
  collection,
  healthContext,
  item,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUPS = [item('Group 1', { group_name: 'Vault Admins' }), item('Group 2', { group_name: 'Vault Operators' })]

describe('CyberArk Vault Groups Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(GROUPS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared group is present', async () => {
    const fake = recordFetch([
      LOGON,
      collection([{ id: 7, groupName: 'Vault Admins' }, { id: 9, groupName: 'Vault Operators' }]),
    ])
    try {
      const result = await healthCheck(healthContext(GROUPS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      // Membership is not re-read here — one list call is the whole check.
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific group that has gone missing', async () => {
    const fake = recordFetch([LOGON, collection([{ id: 7, groupName: 'Vault Admins' }])])
    try {
      const result = await healthCheck(healthContext(GROUPS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'group:Vault Operators')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(GROUPS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
