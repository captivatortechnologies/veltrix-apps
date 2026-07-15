import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'URL filtering',
  'Cloud firewall',
  'DLP',
  'SSL inspection',
  'Locations',
  'Admin',
  'App segments',
  'Access policy',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-client',
      label: '1. API client',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the <strong>Zidentity Admin portal</strong>, create an <strong>API client</strong>{' '}
              (client-credentials). Grant it the ZIA/ZPA roles for what this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the <strong>Client ID</strong> and <strong>Client Secret</strong>. One OneAPI token
              works for both ZIA and ZPA.
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
            <p>Store the API client as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the <code>Client ID</code>
              </li>
              <li>
                <strong>API token</strong> → the <code>Client Secret</code>
              </li>
            </ul>
            <p>
              The app exchanges these for a bearer token at{' '}
              <code>https://&lt;vanity&gt;.zslogin.net/oauth2/v1/token</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & settings',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>zscaler-tenant</strong> component whose hostname is your{' '}
              <strong>Zidentity vanity domain</strong> (the tenant subdomain, e.g. <code>acme</code>)
              and attach the credential.
            </p>
            <p>
              Leave <strong>Cloud</strong> blank for commercial production (<code>api.zsapi.net</code>
              ); set <code>gov</code>/<code>govus</code> for government clouds. To manage <strong>ZPA</strong>{' '}
              configuration, set the <strong>ZPA Customer ID</strong> app setting (from the ZPA Admin
              Portal under Configuration &amp; Control &gt; Public API &gt; API Keys). ZIA-only
              deployments can leave it blank.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
