import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { PolicyException, PolicySchedule } from '../../lib/model/types'
import { readBoolean, readString } from './readers'

export function readExceptionItem(item: CanvasItemSnapshot): Record<string, unknown> {
  const fields = item.fields ?? {}
  return {
    policy: readString(fields, 'policy'),
    resourceId: readString(fields, 'resourceId'),
    reason: readString(fields, 'reason'),
    approver: readString(fields, 'approver'),
    expiresAt: readString(fields, 'expiresAt'),
  }
}

export function readScheduleItem(item: CanvasItemSnapshot): Record<string, unknown> {
  const fields = item.fields ?? {}
  return {
    policy: readString(fields, 'policy'),
    cron: readString(fields, 'cron'),
    enabled: readBoolean(fields, 'enabled', true),
    enforcement: readString(fields, 'enforcement') || 'observe',
  }
}

export const exceptionKey = (e: Pick<PolicyException, 'policy' | 'resourceId'>): string => `${e.policy}/${e.resourceId}`
export const scheduleKey = (s: Pick<PolicySchedule, 'policy'>): string => s.policy
