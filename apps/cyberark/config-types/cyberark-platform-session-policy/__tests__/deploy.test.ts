import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  bodyOf,
  deployContext,
  isLogon,
  item,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const POLICY = item('Policy 1', {
  platform_id: 'WinServerLocal',
  psm_server_id: 'PSMServer_01',
  psm_server_name: 'Primary PSM',
  psm_connectors: { 'PSM-RDP': 'true', 'PSM-SSH': 'false' },
})

const POLICY_URL = `${API_URL}/Platforms/Targets/WinServerLocal/PrivilegedSessionManagement/`

const LIVE_POLICY = ok({
  PSMServerId: 'PSMServer_OLD',
  PSMServerName: 'Legacy PSM',
  PSMConnectors: [{ PSMConnectorID: 'PSM-RDP', Enabled: false }],
})

describe('CyberArk Platform Session Policy Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([POLICY], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, LIVE_POLICY, ok()])
    try {
      await deploy(deployContext([POLICY]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('reads the current policy before replacing it, and captures it for rollback', async () => {
    const fake = recordFetch([LOGON, LIVE_POLICY, ok()])
    try {
      const result = await deploy(deployContext([POLICY]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].url).toBe(POLICY_URL)

      expect(calls[1].method).toBe('PUT')
      expect(calls[1].url).toBe(POLICY_URL)
      expect(bodyOf(calls[1])).toEqual({
        PSMServerId: 'PSMServer_01',
        PSMServerName: 'Primary PSM',
        PSMConnectors: [
          { PSMConnectorID: 'PSM-RDP', Enabled: true },
          { PSMConnectorID: 'PSM-SSH', Enabled: false },
        ],
      })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ platformId: string; prior: { PSMServerId?: string } }>
      }
      expect(rollbackData.previousState[0].platformId).toBe('WinServerLocal')
      expect(rollbackData.previousState[0].prior.PSMServerId).toBe('PSMServer_OLD')
    } finally {
      fake.restore()
    }
  })

  it('omits PSMConnectors entirely when none are declared, rather than wiping them', async () => {
    const fake = recordFetch([LOGON, LIVE_POLICY, ok()])
    try {
      await deploy(
        deployContext([item('Policy 1', { platform_id: 'WinServerLocal', psm_server_id: 'PSMServer_01' })]),
      )

      const body = bodyOf(vendorCalls(fake.calls)[1]) as Record<string, unknown>
      expect(body).toEqual({ PSMServerId: 'PSMServer_01' })
      expect(body.PSMConnectors).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the platform has no policy to read', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Platform WinServerLocal was not found')])
    try {
      const result = await deploy(deployContext([POLICY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Platform WinServerLocal was not found')
      // Nothing was written after a failed read.
      expect(vendorCalls(fake.calls).some((c) => c.method === 'PUT')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the write', async () => {
    const fake = recordFetch([LOGON, LIVE_POLICY, pvwaError(403, 'Not authorized to manage session policy')])
    try {
      const result = await deploy(deployContext([POLICY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to manage session policy')
      expect(result.message).toMatch(/0 of 1/)
      // The prior policy is still recorded so rollback can restore it.
      const rollbackData = result.rollbackData as { previousState: unknown[] }
      expect(rollbackData.previousState).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('keeps going per platform and reports how far it got', async () => {
    const second = item('Policy 2', { platform_id: 'UnixSSH', psm_server_id: 'PSMServer_01' })
    const fake = recordFetch([LOGON, LIVE_POLICY, ok(), LIVE_POLICY, pvwaError(500, 'PVWA is down')])
    try {
      const result = await deploy(deployContext([POLICY, second]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 2/)
      expect((result.artifacts as { deployedPlatforms: string[] }).deployedPlatforms).toEqual(['WinServerLocal'])
      const rollbackData = result.rollbackData as { previousState: unknown[] }
      expect(rollbackData.previousState).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('skips an item that names no PSM server rather than sending an empty policy', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await deploy(deployContext([item('Policy 1', { platform_id: 'WinServerLocal' })]))

      expect(result.success).toBe(true)
      expect(vendorCalls(fake.calls)).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })
})
