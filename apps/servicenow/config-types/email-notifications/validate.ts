import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr, readStringArray } from '../../lib/tableRecords'
import { TABLE_RE } from './_shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate email-notification items. Static — no target access required:
 *   - a non-empty name, table and event name (this config type is event-driven only)
 *   - a non-empty subject and message
 *   - at least one recipient (users, groups or fields)
 * Identity is (name, table, event name); a duplicate identity is flagged
 * (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one email notification.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const table = trimStr(item.fields.collection)
    const eventName = trimStr(item.fields.eventName)
    const subject = trimStr(item.fields.subject)
    const messageHtml = String(item.fields.messageHtml ?? '').trim()
    const replyTo = trimStr(item.fields.replyTo)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    }

    if (!table) {
      errors.push({ field: `items[${i}].collection`, message: 'Table is required.', code: 'EMPTY_TABLE' })
    } else if (!TABLE_RE.test(table)) {
      errors.push({
        field: `items[${i}].collection`,
        message: `Table "${table}" must be an internal table name (lowercase letters, digits and underscores).`,
        code: 'INVALID_TABLE',
      })
    }

    if (!eventName) {
      errors.push({
        field: `items[${i}].eventName`,
        message: 'Event name is required — this config type manages event-driven notifications only.',
        code: 'EMPTY_EVENT_NAME',
      })
    }

    if (!subject) {
      errors.push({ field: `items[${i}].subject`, message: 'Subject is required.', code: 'EMPTY_SUBJECT' })
    }

    if (!messageHtml) {
      errors.push({ field: `items[${i}].messageHtml`, message: 'Message is required.', code: 'EMPTY_MESSAGE' })
    }

    if (replyTo && !EMAIL_RE.test(replyTo)) {
      warnings.push({
        field: `items[${i}].replyTo`,
        message: `Reply-to "${replyTo}" does not look like a valid email address.`,
        code: 'INVALID_REPLY_TO',
      })
    }

    const users = readStringArray(item.fields.recipientUsers)
    const groups = readStringArray(item.fields.recipientGroups)
    const fields = readStringArray(item.fields.recipientFields)
    if (users.length === 0 && groups.length === 0 && fields.length === 0) {
      warnings.push({
        field: `items[${i}].recipientUsers`,
        message: `Notification "${name || '(unnamed)'}" has no recipient users, groups or fields — nobody will receive it.`,
        code: 'NO_RECIPIENTS',
      })
    }

    if (name) {
      const key = `${name} ${table} ${eventName}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Notification "${name}" on "${table}" for event "${eventName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
