import rollback from '../rollback'
import type { SessionPolicyRollbackEntry } from '../deploy'
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

const WINDOWS: SessionPolicyRollbackEntry = {
  platformId: 'WinServerLocal',
  prior: {
    PSMServerId: 'PSMServer_OLD',
    PSMServerName: 'Legacy PSM',
    PSMConnectors: [{ PSMConnectorID: 'PSM-RDP', Enabled: false }],
  },
}

const UNIX: SessionPolicyRollbackEntry = {
  platformId: 'UnixSSH',
  prior: { PSMServerId: 'PSMServer_02' },
}

describe('CyberArk Platform Session Policy Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [WINDOWS] }, { credential: null }))

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

  it('restores the captured policy verbatim', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [WINDOWS] }))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/Platforms/Targets/WinServerLocal/PrivilegedSessionManagement/`)
      expect(bodyOf(restore)).toEqual({
        PSMServerId: 'PSMServer_OLD',
        PSMServerName: 'Legacy PSM',
        PSMConnectors: [{ PSMConnectorID: 'PSM-RDP', Enabled: false }],
      })
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('omits connectors the prior policy never carried', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      await rollback(rollbackContext({ previousState: [UNIX] }))

      expect(bodyOf(vendorCalls(fake.calls)[0])).toEqual({ PSMServerId: 'PSMServer_02' })
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [WINDOWS, UNIX] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toMatch('UnixSSH')
      expect(calls[1].url).toMatch('WinServerLocal')
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the restore', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to manage session policy')])
    try {
      const result = await rollback(rollbackContext({ previousState: [WINDOWS] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to manage session policy')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })
})
