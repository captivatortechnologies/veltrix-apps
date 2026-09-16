import driftDetect from '../driftDetect'
import {
  LOGON,
  driftContext,
  item,
  named,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const USER = item('User 1', {
  username: 'svc-backup',
  description: 'backup service account',
  enable_user: true,
  initial_password: 'Str0ng-Initial-Password!',
})

const IN_SYNC = {
  id: 42,
  username: 'svc-backup',
  description: 'backup service account',
  location: '\\',
  enableUser: true,
  passwordNeverExpires: false,
}

describe('CyberArk Vault Users Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([USER], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live user matches the deployed config', async () => {
    const fake = recordFetch([LOGON, named('Users', [IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([USER]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted user as critical drift', async () => {
    const fake = recordFetch([LOGON, named('Users', [])])
    try {
      const result = await driftDetect(driftContext([USER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('svc-backup')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a user disabled outside Veltrix as warning drift', async () => {
    const fake = recordFetch([LOGON, named('Users', [{ ...IN_SYNC, enableUser: false }])])
    try {
      const result = await driftDetect(driftContext([USER]))

      const diff = result.diffs.find((d) => d.field === 'svc-backup.enable_user')
      expect(diff?.expected).toBe(true)
      expect(diff?.actual).toBe(false)
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('never compares the write-only password, even when one is declared', async () => {
    const fake = recordFetch([LOGON, named('Users', [IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([USER]))

      expect(result.diffs).toHaveLength(0)
      // Only the list call — no attempt to read a secret back.
      expect(vendorCalls(fake.calls)).toHaveLength(1)
      expect(JSON.stringify(result).includes('Str0ng-Initial-Password!')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([USER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
