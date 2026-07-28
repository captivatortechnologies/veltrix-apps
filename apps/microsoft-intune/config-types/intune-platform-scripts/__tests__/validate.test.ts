import validate, {
  buildScriptBody,
  decodeScriptContent,
  encodeScriptContent,
  extractScriptSpecs,
  hasAnyAssignment,
  normalizeScript,
  scriptKey,
  DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE,
} from '../validate'
import { captureManagedFields } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-platform-scripts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-platform-scripts',
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

describe('Intune Platform Scripts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a script with a name, content, run-as account and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            script_name: 'Set Registry',
            fileName: 'set-registry.ps1',
            scriptText: 'Write-Host "hello"',
            runAsAccount: 'system',
            includeGroups: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a script name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { scriptText: 'Write-Host 1', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires script content', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { script_name: 'No Body', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate script names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { script_name: 'Baseline', scriptText: 'x', allDevices: true } },
        { name: 'b', fields: { script_name: 'BASELINE', scriptText: 'y', allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_script')).toBe(true)
  })

  it('rejects an invalid run-as account', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { script_name: 'Bad', scriptText: 'x', runAsAccount: 'root', allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_run_as')).toBe(true)
  })

  it('warns when the file name is not a .ps1 file', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { script_name: 'Bat', scriptText: 'x', fileName: 'run.bat', allDevices: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'invalid_filename')).toBe(true)
  })

  it('warns when a script targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { script_name: 'Orphan', scriptText: 'x' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractScriptSpecs', () => {
  it('reads name/description/fileName, preserves script text, defaults run-as, reads assignments', () => {
    const specs = extractScriptSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            script_name: '  Set Registry  ',
            description: '  set a key  ',
            fileName: '  set.ps1  ',
            scriptText: 'Write-Host "hi"\n',
            runAs32Bit: true,
            enforceSignatureCheck: true,
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: false,
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Set Registry')
    expect(specs[0].description).toBe('set a key')
    expect(specs[0].fileName).toBe('set.ps1')
    // Script text is preserved verbatim (trailing newline kept).
    expect(specs[0].scriptText).toBe('Write-Host "hi"\n')
    // Blank run-as defaults to system.
    expect(specs[0].runAsAccount).toBe('system')
    expect(specs[0].runAs32Bit).toBe(true)
    expect(specs[0].enforceSignatureCheck).toBe(true)
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allUsers).toBe(true)
    expect(specs[0].assignments.allDevices).toBe(false)
  })

  it('keeps an explicit user run-as account', () => {
    const specs = extractScriptSpecs(
      makeCtx([{ name: 'p', fields: { script_name: 'U', scriptText: 'x', runAsAccount: 'user' } }]).canvas,
    )
    expect(specs[0].runAsAccount).toBe('user')
  })

  it('scriptKey trims and lowercases', () => {
    expect(scriptKey('  Set Registry ')).toBe('set registry')
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })
})

describe('base64 scriptContent', () => {
  it('encodes and decodes plain PowerShell round-trip', () => {
    const text = 'Write-Host "hello world"\nGet-Date'
    const encoded = encodeScriptContent(text)
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(decodeScriptContent(encoded)).toBe(text)
  })

  it('decodes empty/non-string content to an empty string', () => {
    expect(decodeScriptContent('')).toBe('')
    expect(decodeScriptContent(undefined)).toBe('')
    expect(decodeScriptContent(null)).toBe('')
  })

  it('normalizeScript ignores CRLF and edge whitespace', () => {
    expect(normalizeScript('a\r\nb\n')).toBe('a\nb')
    expect(normalizeScript('  x  ')).toBe('x')
  })
})

describe('buildScriptBody', () => {
  it('builds a create/PATCH body with the @odata.type, base64 scriptContent and roleScopeTagIds', () => {
    const specs = extractScriptSpecs(
      makeCtx([
        {
          name: 'p',
          fields: { script_name: 'Set', description: 'd', scriptText: 'Write-Host 1', runAsAccount: 'user' },
        },
      ]).canvas,
    )
    const body = buildScriptBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE)
    expect(body.displayName).toBe('Set')
    expect(body.description).toBe('d')
    expect(body.runAsAccount).toBe('user')
    expect(body.roleScopeTagIds).toEqual(['0'])
    // scriptContent is base64 — decoding it returns the plain text.
    expect(decodeScriptContent(body.scriptContent as string)).toBe('Write-Host 1')
  })

  it('defaults the file name to script.ps1 when left blank', () => {
    const specs = extractScriptSpecs(
      makeCtx([{ name: 'p', fields: { script_name: 'Set', scriptText: 'x' } }]).canvas,
    )
    const body = buildScriptBody(specs[0]) as Record<string, unknown>
    expect(body.fileName).toBe('script.ps1')
  })
})

describe('deploy helpers', () => {
  it('captureManagedFields keeps managed fields (incl base64 scriptContent) and drops read-only state', () => {
    const captured = captureManagedFields({
      '@odata.type': DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE,
      id: 'abc',
      displayName: 'Set',
      fileName: 'set.ps1',
      scriptContent: 'V3JpdGUtSG9zdCAx',
      runAsAccount: 'system',
      enforceSignatureCheck: true,
      runAs32Bit: false,
      createdDateTime: '2026-01-01T00:00:00Z',
      lastModifiedDateTime: '2026-01-02T00:00:00Z',
    })
    expect(captured.fileName).toBe('set.ps1')
    expect(captured.scriptContent).toBe('V3JpdGUtSG9zdCAx')
    expect(captured.runAsAccount).toBe('system')
    expect(captured.enforceSignatureCheck).toBe(true)
    expect(captured.createdDateTime).toBeUndefined()
    expect(captured.lastModifiedDateTime).toBeUndefined()
  })
})
