import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const PERMISSIONS = ['DeviceManagementConfiguration.ReadWrite.All']

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
              In Microsoft Entra ID, create an <strong>app registration</strong> and add this Microsoft
              Graph <strong>application</strong> permission (with admin consent):
            </p>
            <div>
              {PERMISSIONS.map((p) => (
                <Badge key={p} variant="primary" size="sm">
                  {p}
                </Badge>
              ))}
            </div>
            <p>
              The tenant also needs an <strong>Intune license</strong>. Endpoint-security policies use
              the Graph <strong>beta</strong> API (<code>/deviceManagement/configurationPolicies</code>).
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
              The app exchanges these for a Graph bearer token at{' '}
              <code>login.microsoftonline.com/&lt;tenant&gt;/oauth2/v2.0/token</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & tenant',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>intune-tenant</strong> component and attach the credential. Then set
              the <strong>Tenant ID</strong> app setting (your Entra directory GUID) and the{' '}
              <strong>Azure Cloud</strong> setting (commercial or a US Gov cloud).
            </p>
            <p>
              US Gov High / DoD tenants use the <code>graph.microsoft.us</code> endpoint automatically
              based on the Azure Cloud setting.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
