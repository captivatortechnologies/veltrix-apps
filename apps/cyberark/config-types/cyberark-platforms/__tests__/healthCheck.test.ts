import healthCheck from '../healthCheck'
import { LOGON, healthContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const PLATFORMS = [
  item('Platform 1', { platform_id: 'WinSrvCustom', active: true }),
  item('Platform 2', { platform_id: 'UnixSSHCustom', active: false }),
]

describe('CyberArk Platforms Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(PLATFORMS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every platform is present with the declared active state', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', [
        { ID: 9, PlatformID: 'WinSrvCustom', Active: true },
        { ID: 10, PlatformID: 'UnixSSHCustom', Active: false },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(PLATFORMS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('fails a platform that is present but in the wrong active state', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', [
        { ID: 9, PlatformID: 'WinSrvCustom', Active: false },
        { ID: 10, PlatformID: 'UnixSSHCustom', Active: false },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(PLATFORMS))

      expect(result.healthy).toBe(false)
      const check = result.checks.find((c) => c.name === 'platform:WinSrvCustom')
      expect(check?.passed).toBe(false)
      expect(check?.message).toMatch('expected active')
    } finally {
      fake.restore()
    }
  })

  it('reports the specific platform that has gone missing', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }])])
    try {
      const result = await healthCheck(healthContext(PLATFORMS))

      const check = result.checks.find((c) => c.name === 'platform:UnixSSHCustom')
      expect(check?.passed).toBe(false)
      expect(check?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(PLATFORMS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
