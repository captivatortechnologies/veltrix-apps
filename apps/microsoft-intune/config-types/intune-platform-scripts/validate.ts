import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { hasAnyAssignment, type AssignmentSpec } from '../../lib/assignments'

/** The concrete Graph type of an Intune platform script (deviceManagementScript). */
export const DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE = '#microsoft.graph.deviceManagementScript'

/** runAsAccount (runAsAccountType enum). */
export const RUN_AS_ACCOUNTS = ['system', 'user'] as const
export type RunAsAccount = (typeof RUN_AS_ACCOUNTS)[number]

/** Fallback file name when the user leaves it blank (Intune requires a .ps1 file name). */
export const DEFAULT_SCRIPT_FILE_NAME = 'script.ps1'

/**
 * The writable Graph properties this type manages, besides displayName/description/
 * roleScopeTagIds. Captured raw off a live script for exact rollback restore —
 * scriptContent stays base64 here (only drift decodes it to compare text).
 */
export const SCRIPT_MANAGED_FIELDS = [
  'fileName',
  'scriptContent',
  'runAsAccount',
  'enforceSignatureCheck',
  'runAs32Bit',
] as const

export interface PlatformScriptSpec {
  sectionName: string
  name: string
  description: string
  fileName: string
  /** Plain PowerShell text; base64-encoded into scriptContent at deploy. */
  scriptText: string
  /** Kept raw (not narrowed) so validate can flag an unknown value. */
  runAsAccount: string
  enforceSignatureCheck: boolean
  runAs32Bit: boolean
  assignments: AssignmentSpec
}

/** The script name is the reconciliation key. */
export function scriptKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a checkbox field; undefined when unset. */
function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no' || v === '') return false
  }
  return undefined
}

/** Base64-encode plain PowerShell text into the Graph scriptContent value. */
export function encodeScriptContent(text: string): string {
  return Buffer.from(text ?? '', 'utf8').toString('base64')
}

/** Decode a base64 scriptContent back to plain text (empty string on anything unusable). */
export function decodeScriptContent(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** Normalize script text for drift comparison (CRLF → LF, trim edges) to avoid false drift. */
export function normalizeScript(text: string): string {
  return (text ?? '').replace(/\r\n/g, '\n').trim()
}

// hasAnyAssignment lives once in lib/assignments (imported above); re-exported here
// for this type's deploy/drift/tests that import it from ./validate.
export { hasAnyAssignment }

/** Each canvas item is one platform script: name + PowerShell + execution options + assignments. */
export function extractScriptSpecs(canvas: CanvasSnapshot): PlatformScriptSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const runAsRaw = typeof fields.runAsAccount === 'string' ? fields.runAsAccount.trim() : ''
    return {
      sectionName: section.name,
      name: typeof fields.script_name === 'string' ? fields.script_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      fileName: typeof fields.fileName === 'string' ? fields.fileName.trim() : '',
      // Preserve the script verbatim (no trim) so what deploys matches what was authored.
      scriptText: typeof fields.scriptText === 'string' ? fields.scriptText : '',
      runAsAccount: runAsRaw || 'system',
      enforceSignatureCheck: readBool(fields.enforceSignatureCheck) ?? false,
      runAs32Bit: readBool(fields.runAs32Bit) ?? false,
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices) ?? false,
        allUsers: readBool(fields.allUsers) ?? false,
      },
    }
  })
}

/** Build the create/PATCH body — scriptContent is base64-encoded from the plain script text. */
export function buildScriptBody(spec: PlatformScriptSpec): Record<string, unknown> {
  return {
    '@odata.type': DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    fileName: spec.fileName || DEFAULT_SCRIPT_FILE_NAME,
    scriptContent: encodeScriptContent(spec.scriptText),
    runAsAccount: spec.runAsAccount,
    enforceSignatureCheck: spec.enforceSignatureCheck,
    runAs32Bit: spec.runAs32Bit,
    roleScopeTagIds: ['0'],
  }
}

/**
 * Validate platform scripts: each needs a unique name and PowerShell content, and a
 * known run-as account (system|user). A non-.ps1 file name is warned, and a script
 * with no assignment target is warned (it would run on nothing).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no platform script items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScriptSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.script_name`, message: 'Script name is required', code: 'required' })
    } else {
      const key = scriptKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.script_name`, message: `Duplicate script name "${spec.name}"`, code: 'duplicate_script' })
      }
      seen.add(key)
    }

    if (!spec.scriptText.trim()) {
      errors.push({ field: `${prefix}.scriptText`, message: 'Script content (PowerShell) is required', code: 'required' })
    }

    if (!RUN_AS_ACCOUNTS.includes(spec.runAsAccount as RunAsAccount)) {
      errors.push({
        field: `${prefix}.runAsAccount`,
        message: `Run-as account "${spec.runAsAccount}" is not valid — use system or user`,
        code: 'invalid_run_as',
      })
    }

    if (spec.fileName && !spec.fileName.toLowerCase().endsWith('.ps1')) {
      warnings.push({
        field: `${prefix}.fileName`,
        message: 'Intune platform scripts must be PowerShell (.ps1) files — the file name should end in .ps1',
        code: 'invalid_filename',
      })
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Script has no assignment — add include groups or target all devices/users, or it will run on nothing',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
