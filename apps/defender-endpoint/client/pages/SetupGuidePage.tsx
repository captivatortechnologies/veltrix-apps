import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const PERMISSIONS = ['Ti.ReadWrite.All (WindowsDefenderATP)', 'CustomDetection.ReadWrite.All (Graph — preview)']

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
              In Microsoft Entra ID, create an <strong>app registration</strong> and add these{' '}
              <strong>application</strong> permissions (with admin consent):
            </p>
            <div>
              {PERMISSIONS.map((p) => (
                <Badge key={p} variant="primary" size="sm">
                  {p}
                </Badge>
              ))}
            </div>
            <p>
              Add <code>Ti.ReadWrite.All</code> under <strong>APIs my organization uses →
              WindowsDefenderATP</strong>. The Graph permission is only needed for the (preview)
              custom detection rules.
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
              The app exchanges these for a bearer token at{' '}
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
              Register an <strong>mde-tenant</strong> component whose hostname is your Defender API
              host — <code>api.security.microsoft.com</code> (commercial) or a geo/gov variant — and
              attach the credential.
            </p>
            <p>
              Then set the <strong>Tenant ID</strong> app setting (your Entra directory GUID) and the{' '}
              <strong>Azure Cloud</strong> setting. Custom detection rules (Graph) are available only
              in the commercial cloud.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
