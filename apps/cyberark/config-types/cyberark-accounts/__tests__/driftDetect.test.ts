import driftDetect from '../driftDetect'
import {
  API_URL,
  LOGON,
  MANAGER_USERNAME,
  collection,
  driftContext,
  item,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const ACCOUNT = item('Account 1', {
  name: 'svc-sql',
  safe_name: 'App-Prod',
  platform_id: 'WinServerLocal',
  address: 'sql01.corp.example.com',
  user_name: 'svc_sql',
  secret: 'P@ssw0rd-that-must-never-be-echoed',
})

const IN_SYNC = {
  id: '77_3',
  name: 'svc-sql',
  safeName: 'App-Prod',
  address: 'sql01.corp.example.com',
  userName: 'svc_sql',
  secretManagement: { automaticManagementEnabled: true },
}

const DRIFTED = collection([{ ...IN_SYNC, address: 'moved.corp.example.com' }])

describe('CyberArk Accounts Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([ACCOUNT], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift, and reads no activity log, when the account matches', async () => {
    const fake = recordFetch([LOGON, collection([IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.hasDrift).toBe(false)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted account as critical drift', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('svc-sql@App-Prod')
      expect(result.diffs[0].severity).toBe('critical')
      // A missing account has no id, so no activity log is read for it.
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports an address change and attributes it to the last human change', async () => {
    const fake = recordFetch([
      LOGON,
      DRIFTED,
      ok({
        Activities: [
          { User: 'dave', Date: 1_710_000_000, Action: 'Modify object properties' },
          { User: 'erin', Date: 1_700_000_000, Action: 'Retrieve password' },
        ],
      }),
    ])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      const diff = result.diffs.find((d) => d.field === 'svc-sql@App-Prod.address')
      expect(diff?.expected).toBe('sql01.corp.example.com')
      expect(diff?.actual).toBe('moved.corp.example.com')
      expect(diff?.severity).toBe('warning')
      expect(diff?.actor?.name).toBe('dave')
      expect(diff?.actor?.at).toBe('2024-03-09T16:00:00.000Z')

      expect(vendorCalls(fake.calls)[1].url).toBe(`${API_URL}/Accounts/77_3/Activities`)
    } finally {
      fake.restore()
    }
  })

  it("leaves drift last touched by Veltrix's own connection unattributed", async () => {
    const fake = recordFetch([
      LOGON,
      DRIFTED,
      ok({ Activities: [{ User: MANAGER_USERNAME, Date: 1_710_000_000, Action: 'Modify object properties' }] }),
    ])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actor).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('never attributes drift to the CPM automation', async () => {
    const fake = recordFetch([
      LOGON,
      DRIFTED,
      ok({ Activities: [{ User: 'PasswordManager', Date: 1_710_000_000, Action: 'CPM Change Password' }] }),
    ])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.diffs[0].actor).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('still reports the drift when the activity log cannot be read', async () => {
    const fake = recordFetch([LOGON, DRIFTED, pvwaError(403, 'No audit permission')])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      // Attribution is best-effort — it must never suppress or fail a drift check.
      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('svc-sql@App-Prod.address')
      expect(result.diffs[0].actor).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('reports automatic management being turned off as informational drift', async () => {
    const fake = recordFetch([
      LOGON,
      collection([{ ...IN_SYNC, secretManagement: { automaticManagementEnabled: false } }]),
      ok({ Activities: [] }),
    ])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('svc-sql@App-Prod.automaticManagement')
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('never reads the secret back, and never echoes the declared one', async () => {
    const fake = recordFetch([LOGON, collection([IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(JSON.stringify(result).includes('P@ssw0rd-that-must-never-be-echoed')).toBe(false)
      expect(vendorCalls(fake.calls).some((c) => /secret/i.test(c.url))).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([ACCOUNT]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
