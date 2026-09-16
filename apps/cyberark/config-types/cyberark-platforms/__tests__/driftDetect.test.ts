import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const PLATFORM = item('Platform 1', { platform_id: 'WinSrvCustom', active: true, import_package: 'UEsDBBQ=' })

describe('CyberArk Platforms Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([PLATFORM], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the platform is present and active as declared', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }])])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      expect(result.hasDrift).toBe(false)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted platform as critical drift', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [])])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('WinSrvCustom')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a platform deactivated outside Veltrix as warning drift', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: false }])])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('WinSrvCustom.active')
      expect(result.diffs[0].expected).toBe(true)
      expect(result.diffs[0].actual).toBe(false)
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('leaves platform diffs unattributed without spending an extra call on it', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: false }])])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      // A target platform carries no creator/modifier metadata and has no
      // activity endpoint — attribution must resolve nothing and cost nothing.
      expect(result.diffs[0].actor).toBeUndefined()
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('never echoes the write-only import package into a diff', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: false }])])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      expect(JSON.stringify(result).includes('UEsDBBQ=')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([PLATFORM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
