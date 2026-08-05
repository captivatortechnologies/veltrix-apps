// Shared GraphQL documents + read-side types for Cato Global IP Range network
// objects (object(accountId) - a plain, BULK object CRUD surface, NOT part of
// the staged policy revision workflow - see canvas.yaml header).

export const LIST_GLOBAL_IP_RANGES = `query ListGlobalIpRanges($accountId: ID!) {
  object(accountId: $accountId) {
    globalIpRangeList(input: { filter: {} }) {
      items { id name description ipRange }
      total
    }
  }
}`

export const CREATE_GLOBAL_IP_RANGE_BULK = `mutation CreateGlobalIpRangeBulk($accountId: ID!, $input: [CreateGlobalIpRangeInput!]!) {
  object(accountId: $accountId) {
    createGlobalIpRangeBulk(input: $input) {
      globalIpRange { id name }
    }
  }
}`

export const UPDATE_GLOBAL_IP_RANGE_BULK = `mutation UpdateGlobalIpRangeBulk($accountId: ID!, $input: [UpdateGlobalIpRangeInput!]!) {
  object(accountId: $accountId) {
    updateGlobalIpRangeBulk(input: $input) {
      globalIpRange { id name }
    }
  }
}`

export const DELETE_GLOBAL_IP_RANGE_BULK = `mutation DeleteGlobalIpRangeBulk($accountId: ID!, $input: [GlobalIpRangeRefInput!]!) {
  object(accountId: $accountId) {
    deleteGlobalIpRangeBulk(input: $input) {
      globalIpRange { id name }
    }
  }
}`

export interface LiveGlobalIpRange {
  id: string
  name: string
  description?: string | null
  ipRange?: string | null
}

export function globalIpRangesFromList(data: unknown): LiveGlobalIpRange[] {
  const items = (data as Record<string, any> | null)?.object?.globalIpRangeList?.items
  return Array.isArray(items) ? items : []
}

export function findGlobalIpRange(ranges: LiveGlobalIpRange[], name: string): LiveGlobalIpRange | null {
  const key = name.trim().toLowerCase()
  return ranges.find((r) => r.name.trim().toLowerCase() === key) ?? null
}
