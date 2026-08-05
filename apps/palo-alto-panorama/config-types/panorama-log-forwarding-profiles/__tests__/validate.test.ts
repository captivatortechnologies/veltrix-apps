import validate, {
  extractLogForwardingSpecs,
  buildLogForwardingFields,
  logForwardingDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-log-forwarding-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-log-forwarding-profiles',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Panorama Log Forwarding Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal profile (send-to-panorama on by default)', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'default-forwarding' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported log type', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', log_type: 'syslog' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_log_type')).toBe(true)
  })

  it('warns when no forwarding destination is set at all', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', send_to_panorama: false } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_destination')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'lfp1' } },
        { name: 'b', fields: { name: 'LFP1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds REST fields with a single match-list entry and forwarding targets', () => {
    const spec = extractLogForwardingSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', log_type: 'threat', send_syslog: ['syslog-primary'], quarantine: true } }]).canvas,
    )[0]
    const fields = buildLogForwardingFields(spec) as { 'match-list': { entry: Array<Record<string, unknown>> } }
    const match = fields['match-list'].entry[0]
    expect(match['log-type']).toBe('threat')
    expect(match['send-syslog']).toEqual({ member: ['syslog-primary'] })
    expect(match.quarantine).toBe('yes')
    expect(match['send-to-panorama']).toBe('yes')
  })

  it('detects log-type and forwarding-target drift', () => {
    const spec = extractLogForwardingSpecs(makeCtx([{ name: 'r', fields: { name: 'x', send_syslog: ['syslog-primary'] } }]).canvas)[0]
    const clean = logForwardingDriftDiffs(spec, {
      '@name': 'x',
      'enhanced-application-logging': 'no',
      'match-list': {
        entry: [{ '@name': 'default', 'log-type': 'traffic', 'send-to-panorama': 'yes', 'send-syslog': { member: ['syslog-primary'] }, quarantine: 'no' }],
      },
    })
    expect(clean).toHaveLength(0)
    const drifted = logForwardingDriftDiffs(spec, {
      '@name': 'x',
      'match-list': { entry: [{ '@name': 'default', 'log-type': 'threat', 'send-to-panorama': 'no' }] },
    })
    expect(drifted.some((d) => d.field.endsWith('.log-type'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.send-to-panorama'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.send-syslog'))).toBe(true)
  })
})
