import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  bodyOf,
  created,
  deployContext,
  isLogon,
  item,
  leaksToken,
  named,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

/** ⚠ Write-only: the BASE 64 platform package must reach PVWA and go nowhere else. */
const PACKAGE = 'UEsDBBQAAAAIAAAAIQBpbGlrZWNvZmZlZQ=='

const PLATFORM = item('Platform 1', {
  platform_id: 'WinSrvCustom',
  active: true,
  import_package: PACKAGE,
})

describe('CyberArk Platforms Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([PLATFORM], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', []),
      created({ PlatformID: 'WinSrvCustom' }),
      named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }]),
    ])
    try {
      await deploy(deployContext([PLATFORM]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('imports a platform that does not exist yet, then activates it', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', []),
      created({ PlatformID: 'WinSrvCustom' }),
      named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: false }]),
      ok(),
    ])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Platforms/Targets`)

      const importCall = calls[1]
      expect(importCall.method).toBe('POST')
      expect(importCall.url).toBe(`${API_URL}/Platforms/Import/`)
      expect(bodyOf(importCall)).toEqual({ ImportFile: PACKAGE })

      // Re-read so the numeric ID exists before the active state is reconciled.
      expect(calls[2].url).toBe(`${API_URL}/Platforms/Targets`)
      expect(calls[3].method).toBe('POST')
      expect(calls[3].url).toBe(`${API_URL}/Platforms/Targets/9/activate/`)

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: number }>
        createdIds: number[]
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].id).toBe(9)
      expect(rollbackData.createdIds).toEqual([9])
    } finally {
      fake.restore()
    }
  })

  it('never reports the import package back to the pipeline', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', []),
      created({ PlatformID: 'WinSrvCustom' }),
      named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }]),
    ])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      expect(JSON.stringify(result.message).includes(PACKAGE)).toBe(false)
      expect(JSON.stringify(result.artifacts ?? {}).includes(PACKAGE)).toBe(false)
      expect(JSON.stringify(result.rollbackData ?? {}).includes(PACKAGE)).toBe(false)
      expect(leaksToken(result)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('refuses to invent a platform it has no package for', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [])])
    try {
      const result = await deploy(deployContext([item('Platform 1', { platform_id: 'WinSrvCustom', active: true })]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('no import package was provided')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('deactivates an existing platform whose declared state says inactive', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }]), ok()])
    try {
      const result = await deploy(
        deployContext([item('Platform 1', { platform_id: 'WinSrvCustom', active: false })]),
      )

      const calls = vendorCalls(fake.calls)
      expect(calls[1].url).toBe(`${API_URL}/Platforms/Targets/9/deactivate/`)

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: number; priorActive?: boolean }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].priorActive).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('makes no write when the live active state already matches', async () => {
    const fake = recordFetch([LOGON, named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: true }])])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      expect(vendorCalls(fake.calls)).toHaveLength(1)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the import is rejected', async () => {
    const fake = recordFetch([LOGON, named('Platforms', []), pvwaError(400, 'Platform package is invalid')])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Platform package is invalid')
      expect(result.message.includes(PACKAGE)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the activation is rejected', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', [{ ID: 9, PlatformID: 'WinSrvCustom', Active: false }]),
      pvwaError(403, 'Not authorized to activate platforms'),
    ])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to activate platforms')
    } finally {
      fake.restore()
    }
  })

  it('records an imported platform that is not listable yet rather than failing', async () => {
    const fake = recordFetch([
      LOGON,
      named('Platforms', []),
      created({ PlatformID: 'WinSrvCustom' }),
      named('Platforms', []),
    ])
    try {
      const result = await deploy(deployContext([PLATFORM]))

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: number }>
        createdIds: number[]
      }
      // No numeric ID means rollback has nothing to delete — it must not pretend.
      expect(rollbackData.previousState[0].id).toBeUndefined()
      expect(rollbackData.createdIds).toEqual([])
    } finally {
      fake.restore()
    }
  })
})
