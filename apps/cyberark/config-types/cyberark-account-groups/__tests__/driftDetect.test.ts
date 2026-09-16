import driftDetect from '../driftDetect'
import {
  LOGON,
  collection,
  driftContext,
  item,
  named,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUP = item('Group 1', {
  group_name: 'SQLCluster',
  safe_name: 'App-Prod',
  group_platform_id: 'WinDomainGroup',
  members: '[{"account_name":"svc-sql","safe_name":"App-Prod"}]',
})

const LIVE_GROUP = { GroupID: 12, GroupName: 'SQLCluster', GroupPlatformID: 'WinDomainGroup', Safe: 'App-Prod' }
const ACCOUNT_SEARCH = collection([{ id: '77_3', name: 'svc-sql', safeName: 'App-Prod' }])

describe('CyberArk Account Groups Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([GROUP], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the group and its membership match', async () => {
    const fake = recordFetch([
      LOGON,
      named('value', [LIVE_GROUP]),
      named('Members', [{ AccountID: '77_3' }]),
      ACCOUNT_SEARCH,
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted group as critical drift and reads no membership for it', async () => {
    const fake = recordFetch([LOGON, named('value', [])])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].severity).toBe('critical')
      expect(result.diffs[0].actual).toBe('missing')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports an account detached outside Veltrix as warning drift', async () => {
    const fake = recordFetch([LOGON, named('value', [LIVE_GROUP]), named('Members', []), ACCOUNT_SEARCH])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'SQLCluster @ App-Prod.members')
      expect(diff?.expected).toBe('svc-sql @ App-Prod')
      expect(diff?.actual).toBe('missing')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports a GroupPlatformID change as informational and flags it as not auto-correctable', async () => {
    const fake = recordFetch([
      LOGON,
      named('value', [{ ...LIVE_GROUP, GroupPlatformID: 'SomethingElse' }]),
      named('Members', [{ AccountID: '77_3' }]),
      ACCOUNT_SEARCH,
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toMatch('not auto-correctable')
      expect(result.diffs[0].expected).toBe('WinDomainGroup')
      expect(result.diffs[0].actual).toBe('SomethingElse')
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([
      LOGON,
      named('value', [LIVE_GROUP]),
      named('Members', [{ AccountID: '77_3' }]),
      pvwaError(500, 'PVWA is down'),
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
