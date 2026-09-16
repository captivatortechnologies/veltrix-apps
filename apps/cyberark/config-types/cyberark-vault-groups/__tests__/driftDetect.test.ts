import driftDetect from '../driftDetect'
import {
  API_URL,
  LOGON,
  collection,
  driftContext,
  item,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUP = item('Group 1', {
  group_name: 'Vault Admins',
  description: 'privileged vault administrators',
  members: '[{"member_id":"alice","member_type":"vault"}]',
})

const LIVE_GROUP = {
  id: 7,
  groupName: 'Vault Admins',
  description: 'privileged vault administrators',
  location: '\\',
}

describe('CyberArk Vault Groups Drift Detect Handler', () => {
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

  it('reports no drift when fields and membership both match', async () => {
    const fake = recordFetch([
      LOGON,
      collection([LIVE_GROUP]),
      ok({ id: 7, members: [{ username: 'alice', memberType: 'vault' }] }),
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(vendorCalls(fake.calls)[1].url).toBe(`${API_URL}/UserGroups/7?includeMembers=true`)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted group as critical drift and reads no membership for it', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Vault Admins')
      expect(result.diffs[0].severity).toBe('critical')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a member removed outside Veltrix as warning drift', async () => {
    const fake = recordFetch([LOGON, collection([LIVE_GROUP]), ok({ id: 7, members: [] })])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Vault Admins.members')
      expect(diff?.expected).toBe('alice')
      expect(diff?.actual).toBe('missing')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports an undeclared member added outside Veltrix as warning drift', async () => {
    const fake = recordFetch([
      LOGON,
      collection([LIVE_GROUP]),
      ok({ id: 7, members: [{ username: 'alice', memberType: 'vault' }, { username: 'mallory', memberType: 'vault' }] }),
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.actual === 'mallory')
      expect(diff?.expected).toBe('not declared')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports a description change as informational drift', async () => {
    const fake = recordFetch([
      LOGON,
      collection([{ ...LIVE_GROUP, description: 'edited in the PVWA UI' }]),
      ok({ id: 7, members: [{ username: 'alice', memberType: 'vault' }] }),
    ])
    try {
      const result = await driftDetect(driftContext([GROUP]))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Vault Admins.description')
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
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
