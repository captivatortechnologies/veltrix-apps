import healthCheck from '../healthCheck'
import { LOGON, healthContext, item, ok, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const POLICIES = [
  item('Policy 1', { platform_id: 'WinServerLocal', psm_server_id: 'PSMServer_01' }),
  item('Policy 2', { platform_id: 'UnixSSH', psm_server_id: 'PSMServer_01' }),
]

describe('CyberArk Platform Session Policy Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(POLICIES, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every platform routes to the declared PSM server', async () => {
    const fake = recordFetch([LOGON, ok({ PSMServerId: 'PSMServer_01' }), ok({ PSMServerId: 'PSMServer_01' })])
    try {
      const result = await healthCheck(healthContext(POLICIES))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(vendorCalls(fake.calls)).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('names the PSM server a platform has actually been pointed at', async () => {
    const fake = recordFetch([LOGON, ok({ PSMServerId: 'PSMServer_ROGUE' }), ok({ PSMServerId: 'PSMServer_01' })])
    try {
      const result = await healthCheck(healthContext(POLICIES))

      expect(result.healthy).toBe(false)
      const check = result.checks.find((c) => c.name === 'platform:WinServerLocal')
      expect(check?.passed).toBe(false)
      expect(check?.message).toMatch('PSMServer_ROGUE')
      expect(check?.message).toMatch('expected "PSMServer_01"')
    } finally {
      fake.restore()
    }
  })

  it('fails only the platform whose policy cannot be read', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Platform not found'), ok({ PSMServerId: 'PSMServer_01' })])
    try {
      const result = await healthCheck(healthContext(POLICIES))

      expect(result.healthy).toBe(false)
      // One platform still answered, so PVWA itself is reachable.
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].passed).toBe(true)
      const failed = result.checks.find((c) => c.name === 'platform:WinServerLocal')
      expect(failed?.passed).toBe(false)
      expect(failed?.message).toMatch('Platform not found')
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA as unreachable when no platform answers at all', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down'), pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(POLICIES))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].passed).toBe(false)
    } finally {
      fake.restore()
    }
  })
})
