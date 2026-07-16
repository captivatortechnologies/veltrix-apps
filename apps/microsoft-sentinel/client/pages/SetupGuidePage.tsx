import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const ROLES = ['Microsoft Sentinel Contributor']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'app',
      label: '1. App registration',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Microsoft Entra ID, create an <strong>app registration</strong>. Then, in the Azure
              subscription that holds the workspace, grant its <strong>service principal</strong> this Azure
              role (scoped to the workspace <strong>resource group</strong>):
            </p>
            <div>
              {ROLES.map((r) => (
                <Badge key={r} variant="primary" size="sm">
                  {r}
                </Badge>
              ))}
            </div>
            <p>
              Sentinel is managed through <strong>Azure Resource Manager</strong> (not Microsoft Graph), so
              the token audience is <code>https://management.azure.com/.default</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the app registration as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the app's <strong>Client ID</strong>
              </li>
              <li>
                <strong>API token</strong> → a <strong>Client Secret</strong>
              </li>
            </ul>
            <p>
              The app exchanges these for an ARM bearer token at{' '}
              <code>login.microsoftonline.com/&lt;tenant&gt;/oauth2/v2.0/token</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & workspace',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>sentinel-workspace</strong> component and attach the credential. Then set
              the app settings that address the workspace: <strong>Tenant ID</strong>,{' '}
              <strong>Subscription ID</strong>, <strong>Resource Group</strong>,{' '}
              <strong>Workspace Name</strong>, and <strong>Azure Cloud</strong>.
            </p>
            <p>
              US Gov High / DoD workspaces use the <code>management.usgovcloudapi.net</code> ARM endpoint and
              the <code>login.microsoftonline.us</code> authority automatically based on the Azure Cloud
              setting.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
