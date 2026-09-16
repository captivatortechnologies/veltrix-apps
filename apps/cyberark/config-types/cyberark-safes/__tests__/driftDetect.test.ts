import driftDetect from '../driftDetect'
import {
  LOGON,
  MANAGER_USERNAME,
  collection,
  driftContext,
  item,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const SAFE = item('Safe 1', {
  safe_name: 'App-Prod',
  description: 'production credentials',
  retention_type: 'days',
  retention_count: 7,
})

const IN_SYNC = {
  safeUrlId: 'App-Prod',
  safeName: 'App-Prod',
  description: 'production credentials',
  numberOfDaysRetention: 7,
  autoPurgeEnabled: false,
}

describe('CyberArk Safes Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([SAFE], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live safe matches the deployed config', async () => {
    const fake = recordFetch([LOGON, collection([IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted safe as critical drift', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('App-Prod')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a retention change as warning drift on the declared retention type', async () => {
    const fake = recordFetch([LOGON, collection([{ ...IN_SYNC, numberOfDaysRetention: 1 }])])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'App-Prod.retention_days')
      expect(diff).toBeDefined()
      expect(diff?.expected).toBe(7)
      expect(diff?.actual).toBe(1)
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports a description and auto-purge change as informational drift', async () => {
    const fake = recordFetch([
      LOGON,
      collection([{ ...IN_SYNC, description: 'edited in the PVWA UI', autoPurgeEnabled: true }]),
    ])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.diffs).toHaveLength(2)
      expect(result.diffs.map((d) => d.field)).toEqual(['App-Prod.description', 'App-Prod.auto_purge'])
      expect(result.diffs.every((d) => d.severity === 'info')).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it("attributes a drifted safe to its creator, read off the safe it already fetched", async () => {
    const fake = recordFetch([
      LOGON,
      collection([
        {
          ...IN_SYNC,
          numberOfDaysRetention: 1,
          creator: { id: '9', name: 'carol@example.com' },
          creationTime: 1_700_000_000,
          lastModificationTime: 1_710_000_000,
        },
      ]),
    ])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.diffs[0].actor?.name).toBe('carol@example.com')
      expect(result.diffs[0].actor?.at).toBe('2024-03-09T16:00:00.000Z')
      // Attribution is read off the listed safe — it must not cost another call.
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it("leaves a safe created by Veltrix's own connection unattributed", async () => {
    const fake = recordFetch([
      LOGON,
      collection([
        {
          ...IN_SYNC,
          numberOfDaysRetention: 1,
          creator: { id: '3', name: MANAGER_USERNAME },
          lastModificationTime: 1_710_000_000,
        },
      ]),
    ])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actor).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([SAFE]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })

  it('makes no call at all when nothing is declared', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await driftDetect(driftContext([]))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })
})
