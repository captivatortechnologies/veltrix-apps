import validate, { extractRemediationSpecs, remediationKey } from '../validate'
import {
  DAILY_SCHEDULE_ODATA_TYPE,
  DEVICE_HEALTH_SCRIPT_ODATA_TYPE,
  HOURLY_SCHEDULE_ODATA_TYPE,
  buildAssignRequest,
  buildRemediationBody,
  buildRunSchedule,
  capturePrior,
  decodeScript,
  encodeScript,
  hasAnyAssignment,
  normalizeScript,
  restoreSpec,
  type LiveDeviceHealthScript,
} from '../remediation'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-device-remediations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-device-remediations',
      items: [],
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000', azure_cloud: 'commercial' },
    platform: stubPlatform,
  }
}

const DETECT = 'Write-Output "check"\nexit 0'
const REMEDIATE = 'Write-Output "fix"\nexit 0'

describe('Intune Device Remediations Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a remediation with a name, a detection script and an assignment', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'Fix Bitlocker', detectionScript: DETECT, allDevices: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a remediation name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { detectionScript: DETECT, allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a detection script', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'No Script', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate remediation names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Repair', detectionScript: DETECT, allDevices: true } },
        { name: 'b', fields: { name: 'REPAIR', detectionScript: DETECT, allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_remediation')).toBe(true)
  })

  it('rejects an unknown runAsAccount value', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'Bad', detectionScript: DETECT, runAsAccount: 'root', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_run_as')).toBe(true)
  })

  it('rejects an hourly interval out of the 1-23 range', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'Hourly', detectionScript: DETECT, scheduleFrequency: 'hourly', scheduleInterval: 30, allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a malformed daily schedule time', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'Timed', detectionScript: DETECT, scheduleFrequency: 'daily', scheduleTime: '9am', allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_time')).toBe(true)
  })

  it('warns when a remediation targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'Orphan', detectionScript: DETECT } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractRemediationSpecs', () => {
  it('reads identity, verbatim scripts, run options, schedule and assignments', () => {
    const specs = extractRemediationSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: '  Fix Time  ',
            description: '  resets clock  ',
            publisher: 'IT',
            detectionScript: DETECT,
            remediationScript: REMEDIATE,
            runAsAccount: 'user',
            enforceSignatureCheck: true,
            runAs32Bit: true,
            scheduleFrequency: 'hourly',
            scheduleInterval: 6,
            scheduleTime: '02:30',
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: false,
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Fix Time')
    expect(specs[0].description).toBe('resets clock')
    expect(specs[0].publisher).toBe('IT')
    // Scripts are kept verbatim (not trimmed) so multi-line PowerShell round-trips.
    expect(specs[0].detectionScript).toBe(DETECT)
    expect(specs[0].remediationScript).toBe(REMEDIATE)
    expect(specs[0].runAsAccount).toBe('user')
    expect(specs[0].enforceSignatureCheck).toBe(true)
    expect(specs[0].runAs32Bit).toBe(true)
    expect(specs[0].schedule.frequency).toBe('hourly')
    expect(specs[0].schedule.interval).toBe(6)
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allUsers).toBe(true)
    expect(specs[0].assignments.allDevices).toBe(false)
  })

  it('defaults runAsAccount to system and schedule to daily 01:00 when unset', () => {
    const specs = extractRemediationSpecs(makeCtx([{ name: 'p', fields: { name: 'Defaults', detectionScript: DETECT } }]).canvas)
    expect(specs[0].runAsAccount).toBe('system')
    expect(specs[0].schedule.frequency).toBe('daily')
    expect(specs[0].schedule.interval).toBe(1)
    expect(specs[0].schedule.time).toBe('01:00')
  })

  it('remediationKey trims and lowercases', () => {
    expect(remediationKey('  Fix Bitlocker ')).toBe('fix bitlocker')
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })
})

describe('buildRemediationBody', () => {
  it('base64-encodes the detection script and carries identity + run options', () => {
    const specs = extractRemediationSpecs(
      makeCtx([{ name: 'p', fields: { name: 'Fix', description: 'd', publisher: 'IT', detectionScript: DETECT, runAsAccount: 'system' } }]).canvas,
    )
    const body = buildRemediationBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(DEVICE_HEALTH_SCRIPT_ODATA_TYPE)
    expect(body.displayName).toBe('Fix')
    expect(body.description).toBe('d')
    expect(body.publisher).toBe('IT')
    expect(body.runAsAccount).toBe('system')
    expect(body.enforceSignatureCheck).toBe(false)
    expect(body.runAs32Bit).toBe(false)
    expect(body.roleScopeTagIds).toEqual(['0'])
    // The content is base64 and decodes back to the original plain text.
    expect(decodeScript(body.detectionScriptContent)).toBe(DETECT)
    // A blank remediation script is omitted entirely.
    expect(body.remediationScriptContent).toBeUndefined()
  })

  it('includes the remediation content only when a remediation script is present', () => {
    const specs = extractRemediationSpecs(
      makeCtx([{ name: 'p', fields: { name: 'Fix', detectionScript: DETECT, remediationScript: REMEDIATE } }]).canvas,
    )
    const body = buildRemediationBody(specs[0]) as Record<string, unknown>
    expect(decodeScript(body.remediationScriptContent)).toBe(REMEDIATE)
  })

  it('coerces an invalid runAsAccount to system on build', () => {
    const specs = extractRemediationSpecs(makeCtx([{ name: 'p', fields: { name: 'Fix', detectionScript: DETECT, runAsAccount: 'bogus' } }]).canvas)
    const body = buildRemediationBody(specs[0]) as Record<string, unknown>
    expect(body.runAsAccount).toBe('system')
  })
})

describe('buildRunSchedule', () => {
  it('builds a daily schedule with interval, HH:MM:SS time and useUtc', () => {
    const sched = buildRunSchedule({ frequency: 'daily', interval: 2, time: '01:00' }) as Record<string, unknown>
    expect(sched['@odata.type']).toBe(DAILY_SCHEDULE_ODATA_TYPE)
    expect(sched.interval).toBe(2)
    expect(sched.time).toBe('01:00:00.0000000')
    expect(sched.useUtc).toBe(false)
  })

  it('builds an hourly schedule with only an interval (no time/useUtc)', () => {
    const sched = buildRunSchedule({ frequency: 'hourly', interval: 4, time: '01:00' }) as Record<string, unknown>
    expect(sched['@odata.type']).toBe(HOURLY_SCHEDULE_ODATA_TYPE)
    expect(sched.interval).toBe(4)
    expect(sched.time).toBeUndefined()
    expect(sched.useUtc).toBeUndefined()
  })
})

describe('buildAssignRequest', () => {
  it('wraps each target with runRemediationScript + runSchedule under deviceHealthScriptAssignments', () => {
    const specs = extractRemediationSpecs(
      makeCtx([{ name: 'p', fields: { name: 'Fix', detectionScript: DETECT, remediationScript: REMEDIATE, includeGroups: ['g1'], scheduleFrequency: 'daily', scheduleInterval: 1, scheduleTime: '03:00' } }]).canvas,
    )
    const req = buildAssignRequest(specs[0]) as { deviceHealthScriptAssignments: Array<Record<string, unknown>> }
    expect(req.deviceHealthScriptAssignments).toHaveLength(1)
    const assignment = req.deviceHealthScriptAssignments[0]
    expect(assignment.runRemediationScript).toBe(true)
    const target = assignment.target as Record<string, unknown>
    expect(target.groupId).toBe('g1')
    const runSchedule = assignment.runSchedule as Record<string, unknown>
    expect(runSchedule['@odata.type']).toBe(DAILY_SCHEDULE_ODATA_TYPE)
    expect(runSchedule.time).toBe('03:00:00.0000000')
  })

  it('sets runRemediationScript false for a detection-only remediation', () => {
    const specs = extractRemediationSpecs(makeCtx([{ name: 'p', fields: { name: 'Detect', detectionScript: DETECT, allDevices: true } }]).canvas)
    const req = buildAssignRequest(specs[0]) as { deviceHealthScriptAssignments: Array<Record<string, unknown>> }
    expect(req.deviceHealthScriptAssignments[0].runRemediationScript).toBe(false)
  })
})

describe('base64 + script normalization', () => {
  it('encodeScript/decodeScript round-trips plain text losslessly', () => {
    const round = decodeScript(encodeScript(DETECT))
    expect(round).toBe(DETECT)
  })

  it('decodeScript returns empty string for a blank or non-string value', () => {
    expect(decodeScript('')).toBe('')
    expect(decodeScript(undefined)).toBe('')
  })

  it('normalizeScript ignores CRLF and trailing whitespace so it never false-positives as drift', () => {
    expect(normalizeScript('a\r\nb  \r\n')).toBe(normalizeScript('a\nb'))
  })
})

describe('capturePrior + restoreSpec', () => {
  it('captures decoded scripts, run options, schedule and assignment from a live script', () => {
    const live: LiveDeviceHealthScript = {
      id: 'abc',
      displayName: 'Fix',
      description: 'prior desc',
      publisher: 'IT',
      detectionScriptContent: encodeScript(DETECT),
      remediationScriptContent: encodeScript(REMEDIATE),
      runAsAccount: 'user',
      enforceSignatureCheck: true,
      runAs32Bit: false,
      assignments: [
        {
          target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g1' },
          runRemediationScript: true,
          runSchedule: { '@odata.type': DAILY_SCHEDULE_ODATA_TYPE, interval: 3, time: '04:15:00.0000000', useUtc: false },
        },
      ],
    }
    const prior = capturePrior(live)
    expect(prior.detectionScript).toBe(DETECT)
    expect(prior.remediationScript).toBe(REMEDIATE)
    expect(prior.runAsAccount).toBe('user')
    expect(prior.enforceSignatureCheck).toBe(true)
    expect(prior.schedule.frequency).toBe('daily')
    expect(prior.schedule.interval).toBe(3)
    expect(prior.schedule.time).toBe('04:15')
    expect(prior.assignments.includeGroupIds).toEqual(['g1'])

    // restoreSpec rebuilds a spec whose body re-encodes the decoded scripts.
    const spec = restoreSpec('Fix', prior)
    const body = buildRemediationBody(spec) as Record<string, unknown>
    expect(decodeScript(body.detectionScriptContent)).toBe(DETECT)
    expect(body.runAsAccount).toBe('user')
  })

  it('reads an hourly live schedule (interval only) back as hourly', () => {
    const live: LiveDeviceHealthScript = {
      id: 'abc',
      displayName: 'Hourly',
      detectionScriptContent: encodeScript(DETECT),
      assignments: [{ runSchedule: { '@odata.type': HOURLY_SCHEDULE_ODATA_TYPE, interval: 8 } }],
    }
    const prior = capturePrior(live)
    expect(prior.schedule.frequency).toBe('hourly')
    expect(prior.schedule.interval).toBe(8)
  })
})
