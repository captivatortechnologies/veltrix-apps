import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateSchedule } from '../../lib/model'
import { readScheduleItem, scheduleKey } from '../lib/guardrailItems'
import { toErrors } from '../lib/results'
import { validateItems } from '../lib/validation'

/**
 * Shape only: policy name, five-field cron, enabled flag, enforcement value and
 * one schedule per policy. The clamp to the policy's own enforcement needs the
 * policy, which only the store knows, so deploy applies it and reports it.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateItems(ctx, {
    label: 'schedule',
    duplicateMessage: (policy) => `Policy "${policy}" has more than one schedule.`,
    check: (item, prefix) => {
      const { value, errors } = validateSchedule(readScheduleItem(item))
      return { identity: value ? scheduleKey(value) : null, errors: toErrors(prefix, errors), warnings: [] }
    },
  })
}
