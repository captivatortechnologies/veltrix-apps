// Shared GraphQL documents + read-side types for Cato Custom Applications
// (customAppData(accountId) - a plain object CRUD surface, NOT part of the
// staged policy revision workflow - see canvas.yaml header).

export const LIST_CUSTOM_APPLICATIONS = `query ListCustomApplications($accountId: ID!) {
  customAppData(accountId: $accountId) {
    customApplicationList(input: { filter: [] }) {
      items { id name description category { id name } criteria { protocol port portRange { from to } destination { fqdn domain destinationIp { ip ipRange { from to } subnet } } } }
    }
  }
}`

export const ADD_CUSTOM_APPLICATION = `mutation AddCustomApplication($accountId: ID!, $input: AddCustomApplicationInput!) {
  customAppData(accountId: $accountId) {
    addCustomApplication(input: $input) {
      customApplication { id name }
    }
  }
}`

export const UPDATE_CUSTOM_APPLICATION = `mutation UpdateCustomApplication($accountId: ID!, $input: UpdateCustomApplicationInput!) {
  customAppData(accountId: $accountId) {
    updateCustomApplication(input: $input) {
      customApplication { id name }
    }
  }
}`

export const DELETE_CUSTOM_APPLICATION = `mutation DeleteCustomApplication($accountId: ID!, $input: DeleteCustomApplicationInput!) {
  customAppData(accountId: $accountId) {
    deleteCustomApplication(input: $input) {
      customApplication { id name }
    }
  }
}`

export interface LiveCustomApplication {
  id: string
  name: string
  description?: string | null
  category?: Array<{ id: string; name: string }>
  criteria?: unknown[]
}

export function customApplicationsFromList(data: unknown): LiveCustomApplication[] {
  const items = (data as Record<string, any> | null)?.customAppData?.customApplicationList?.items
  return Array.isArray(items) ? items : []
}

export function findCustomApplication(apps: LiveCustomApplication[], name: string): LiveCustomApplication | null {
  const key = name.trim().toLowerCase()
  return apps.find((a) => a.name.trim().toLowerCase() === key) ?? null
}
