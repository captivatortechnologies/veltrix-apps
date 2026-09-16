import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, ok, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const POLICY = item('Policy 1', {
  platform_id: 'WinServerLocal',
  psm_server_id: 'PSMServer_01',
  psm_connectors: { 'PSM-RDP': 'true', 'PSM-SSH': 'false' },
})

const IN_SYNC = ok({
  PSMServerId: 'PSMServer_01',
  PSMConnectors: [
    { PSMConnectorID: 'PSM-RDP', Enabled: true },
    { PSMConnectorID: 'PSM-SSH', Enabled: false },
  ],
})

describe('CyberArk Platform Session Policy Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([POLICY], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live policy matches the deployed config', async () => {
    const fake = recordFetch([LOGON, IN_SYNC])
    try {
      const result = await driftDetect(driftContext([POLICY]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('treats a re-pointed PSM server as critical drift — sessions would be brokered elsewhere', async () => {
    const fake = recordFetch([LOGON, ok({ PSMServerId: 'PSMServer_ROGUE' })])
    try {
      const result = await driftDetect(driftContext([POLICY]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'WinServerLocal.psm_server_id')
      expect(diff?.expected).toBe('PSMServer_01')
      expect(diff?.actual).toBe('PSMServer_ROGUE')
      expect(diff?.severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a connector toggled outside Veltrix as warning drift', async () => {
    const fake = recordFetch([
      LOGON,
      ok({ PSMServerId: 'PSMServer_01', PSMConnectors: [{ PSMConnectorID: 'PSM-SSH', Enabled: true }] }),
    ])
    try {
      const result = await driftDetect(driftContext([POLICY]))

      const disabled = result.diffs.find((d) => d.field === 'WinServerLocal.psm_connectors.PSM-RDP')
      expect(disabled?.expected).toBe(true)
      expect(disabled?.actual).toBe(false)
      expect(disabled?.severity).toBe('warning')

      const enabled = result.diffs.find((d) => d.field === 'WinServerLocal.psm_connectors.PSM-SSH')
      expect(enabled?.expected).toBe(false)
      expect(enabled?.actual).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('ignores connectors the config does not declare', async () => {
    const fake = recordFetch([
      LOGON,
      ok({
        PSMServerId: 'PSMServer_01',
        PSMConnectors: [
          { PSMConnectorID: 'PSM-RDP', Enabled: true },
          { PSMConnectorID: 'PSM-SSH', Enabled: false },
          { PSMConnectorID: 'PSM-WebApp', Enabled: true },
        ],
      }),
    ])
    try {
      const result = await driftDetect(driftContext([POLICY]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports a platform whose policy cannot be read as critical drift, not a crash', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Platform not found')])
    try {
      const result = await driftDetect(driftContext([POLICY]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('WinServerLocal')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].actual)).toMatch('Platform not found')
    } finally {
      fake.restore()
    }
  })

  it('keeps checking the remaining platforms after one fails', async () => {
    const second = item('Policy 2', { platform_id: 'UnixSSH', psm_server_id: 'PSMServer_01' })
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down'), ok({ PSMServerId: 'PSMServer_ROGUE' })])
    try {
      const result = await driftDetect(driftContext([POLICY, second]))

      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].field).toBe('WinServerLocal')
      expect(result.diffs[1].field).toBe('UnixSSH.psm_server_id')
    } finally {
      fake.restore()
    }
  })
})
