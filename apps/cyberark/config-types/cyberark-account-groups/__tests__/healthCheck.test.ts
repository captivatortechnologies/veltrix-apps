import healthCheck from '../healthCheck'
import {
  API_URL,
  LOGON,
  healthContext,
  item,
  named,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUPS = [
  item('Group 1', { group_name: 'SQLCluster', safe_name: 'App-Prod', group_platform_id: 'WinDomainGroup' }),
  item('Group 2', { group_name: 'WebCluster', safe_name: 'App-Prod', group_platform_id: 'WinDomainGroup' }),
]

describe('CyberArk Account Groups Health Check Handler', () => {
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
      named('value', [
        { GroupID: 12, GroupName: 'SQLCluster', Safe: 'App-Prod' },
        { GroupID: 13, GroupName: 'WebCluster', Safe: 'App-Prod' },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(GROUPS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      // Both groups live in the same safe, so one list call covers both.
      expect(vendorCalls(fake.calls)).toHaveLength(1)
      expect(vendorCalls(fake.calls)[0].url).toBe(`${API_URL}/AccountGroups?Safe=App-Prod`)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific group that has gone missing', async () => {
    const fake = recordFetch([LOGON, named('value', [{ GroupID: 12, GroupName: 'SQLCluster', Safe: 'App-Prod' }])])
    try {
      const result = await healthCheck(healthContext(GROUPS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'group:WebCluster@App-Prod')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('lists each referenced safe once', async () => {
    const otherSafe = item('Group 3', {
      group_name: 'SQLCluster',
      safe_name: 'App-Legacy',
      group_platform_id: 'WinDomainGroup',
    })
    const fake = recordFetch([LOGON, named('value', []), named('value', [])])
    try {
      await healthCheck(healthContext([...GROUPS, otherSafe]))

      const urls = vendorCalls(fake.calls).map((c) => c.url)
      expect(urls).toEqual([`${API_URL}/AccountGroups?Safe=App-Prod`, `${API_URL}/AccountGroups?Safe=App-Legacy`])
    } finally {
      fake.restore()
    }
  })
})
