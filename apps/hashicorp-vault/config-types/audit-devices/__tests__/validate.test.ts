import validate, {
  buildAuditOptions,
  extractAuditDeviceSpecs,
  normalizeAuditPath,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'audit-devices',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'audit-devices',
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

describe('Vault Audit Devices Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid file audit device', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Device', fields: { path: 'file', type: 'file', filePath: '/var/log/vault/audit.log' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid syslog audit device with no options set', async () => {
    const result = await validate(makeCtx([{ name: 'Device', fields: { path: 'syslog', type: 'syslog' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid syslog audit device with facility and tag', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Device', fields: { path: 'syslog', type: 'syslog', syslogFacility: 'LOCAL0', syslogTag: 'vault' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid socket audit device', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Device', fields: { path: 'socket', type: 'socket', socketAddress: '10.0.0.5:9090', socketType: 'tcp' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a nested path with an internal slash', async () => {
    const result = await validate(
      makeCtx([{ name: 'Device', fields: { path: 'audit/file', type: 'file', filePath: '/tmp/a.log' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing path', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'file', filePath: '/tmp/a.log' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('path'))).toBe(true)
  })

  it('rejects a path with an invalid character', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { path: 'bad path!', type: 'syslog' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'file' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'db', type: 'database' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a file device missing its file path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'file', type: 'file' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('filePath'))).toBe(true)
  })

  it('rejects a socket device missing its address', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { path: 'socket', type: 'socket', socketType: 'tcp' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('socketAddress'))).toBe(true)
  })

  it('rejects a socket device missing its socket type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { path: 'socket', type: 'socket', socketAddress: '10.0.0.5:9090' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('socketType'))).toBe(true)
  })

  it('rejects a socket device with an invalid socket type', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'socket', type: 'socket', socketAddress: '10.0.0.5:9090', socketType: 'sctp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_socket_type')).toBe(true)
  })

  it('rejects a duplicate audit device path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'file', type: 'file', filePath: '/tmp/a.log' } },
        { name: 'sec2', fields: { path: 'file', type: 'file', filePath: '/tmp/b.log' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_device')).toBe(true)
  })

  it('treats "file/" and "file" as the same path when deduping', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'file', type: 'file', filePath: '/tmp/a.log' } },
        { name: 'sec2', fields: { path: 'file/', type: 'file', filePath: '/tmp/b.log' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_device')).toBe(true)
  })

  it('allows two distinct audit device paths', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'file', type: 'file', filePath: '/tmp/a.log' } },
        { name: 'sec2', fields: { path: 'syslog', type: 'syslog' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAuditDeviceSpecs', () => {
  it('trims fields, strips surrounding slashes from the path, and drops empty optionals', () => {
    const specs = extractAuditDeviceSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'hashicorp-vault',
      entityType: 'audit-devices',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            path: '  /file/  ',
            type: '  file  ',
            filePath: '  /var/log/vault/audit.log  ',
            description: '  ',
            syslogTag: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].path).toBe('file')
    expect(specs[0].type).toBe('file')
    expect(specs[0].filePath).toBe('/var/log/vault/audit.log')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].syslogTag).toBeUndefined()
  })
})

describe('normalizeAuditPath', () => {
  it('strips leading and trailing slashes and trims', () => {
    expect(normalizeAuditPath('  /file/  ')).toBe('file')
    expect(normalizeAuditPath('syslog')).toBe('syslog')
    expect(normalizeAuditPath('audit/file/')).toBe('audit/file')
  })
})

describe('buildAuditOptions', () => {
  it('builds only file_path for a file device', () => {
    const options = buildAuditOptions({
      sectionName: 's',
      path: 'file',
      type: 'file',
      filePath: '/tmp/a.log',
      socketAddress: '10.0.0.5:9090',
      socketType: 'tcp',
    })
    expect(options).toEqual({ file_path: '/tmp/a.log' })
  })

  it('builds facility and tag for a syslog device', () => {
    const options = buildAuditOptions({
      sectionName: 's',
      path: 'syslog',
      type: 'syslog',
      syslogFacility: 'LOCAL0',
      syslogTag: 'vault',
      filePath: '/ignored.log',
    })
    expect(options).toEqual({ facility: 'LOCAL0', tag: 'vault' })
  })

  it('builds address and socket_type for a socket device', () => {
    const options = buildAuditOptions({
      sectionName: 's',
      path: 'socket',
      type: 'socket',
      socketAddress: '10.0.0.5:9090',
      socketType: 'udp',
    })
    expect(options).toEqual({ address: '10.0.0.5:9090', socket_type: 'udp' })
  })

  it('omits unset optional options for a syslog device', () => {
    const options = buildAuditOptions({ sectionName: 's', path: 'syslog', type: 'syslog' })
    expect(options).toEqual({})
  })
})
