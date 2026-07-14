import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseConf } from '../../lib/splunkConf'

/**
 * Validate a Config File Set: a target-app namespace plus authored .conf files.
 * Each default/local *.conf file's stanzas are applied over the REST configs
 * API on deploy; non-conf files are skipped (reported here as a warning).
 */

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

interface FileEntry {
  path?: string
  content?: string
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no config file set', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    const description = fields.description as string | undefined
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      errors.push({ field: `${prefix}.description`, message: 'A description explaining why this config is needed is required', code: 'required' })
    }

    const targetApp = fields.targetApp as string | undefined
    if (!targetApp || typeof targetApp !== 'string' || targetApp.trim().length === 0) {
      errors.push({ field: `${prefix}.targetApp`, message: 'Target App is required', code: 'required' })
    } else if (!APP_ID_PATTERN.test(targetApp.trim())) {
      errors.push({
        field: `${prefix}.targetApp`,
        message: 'Target App may contain only letters, digits, underscores and hyphens',
        code: 'invalid_format',
      })
    }

    const files = Array.isArray(fields.files) ? (fields.files as FileEntry[]) : []
    if (files.length === 0) {
      errors.push({ field: `${prefix}.files`, message: 'Add at least one configuration file', code: 'required' })
    }

    let confCount = 0
    files.forEach((file, i) => {
      const path = typeof file?.path === 'string' ? file.path.trim() : ''
      const ref = `${prefix}.files[${i}]`
      if (!path) {
        errors.push({ field: ref, message: 'File path is required', code: 'required' })
        return
      }
      if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
        errors.push({ field: ref, message: `Unsafe file path "${path}"`, code: 'invalid_path' })
        return
      }
      const slash = path.indexOf('/')
      const folder = slash === -1 ? 'default' : path.slice(0, slash)
      const filename = slash === -1 ? path : path.slice(slash + 1)
      if (!filename.endsWith('.conf') || (folder !== 'default' && folder !== 'local')) {
        warnings.push({
          field: ref,
          message: `"${path}" is not a default/local .conf file — it will be skipped on deploy`,
          code: 'not_conf',
        })
        return
      }
      confCount += 1
      // Surface obviously malformed content early (no parseable stanzas).
      if ((file.content ?? '').trim() !== '' && parseConf(file.content ?? '').length === 0) {
        warnings.push({
          field: ref,
          message: `"${path}" has content but no parseable [stanza] — nothing will be applied`,
          code: 'no_stanzas',
        })
      }
    })

    if (files.length > 0 && confCount === 0) {
      warnings.push({
        field: `${prefix}.files`,
        message: 'No default/local .conf files to apply — only .conf files are written over the REST configs API',
        code: 'no_conf_files',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
