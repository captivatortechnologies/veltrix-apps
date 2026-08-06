import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Blueprints', 'Tags', 'Custom Scripts', 'Custom Profiles']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Kandji web app, go to <strong>Settings &gt; Access</strong> and generate an{' '}
              <strong>API Token</strong>. This page also shows your tenant's exact API URL - copy it
              verbatim:
            </p>
            <ul>
              <li>
                US region: <code>https://yourcompany.api.kandji.io</code>
              </li>
              <li>
                EU region: <code>https://yourcompany.api.eu.kandji.io</code>
              </li>
            </ul>
            <p>This app manages:</p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Go to Connections and add one with:</p>
            <ul>
              <li>
                <strong>Endpoint</strong> - your Kandji tenant API URL from step 1, exactly as Kandji shows
                it (e.g. <code>https://yourcompany.api.kandji.io</code>)
              </li>
              <li>
                <strong>API token</strong> - the token you generated in step 1
              </li>
            </ul>
            <p>
              Every request sends it as <code>Authorization: Bearer &lt;token&gt;</code> - there is no
              token exchange or expiry to manage.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy',
      label: '3. Deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Saving the Connection also registers a <strong>kandji-tenant</strong> deploy-target
              Component, so Deploy is enabled immediately.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the pipeline.
              Note: deleting a Blueprint via this app is destructive - it un-manages every device currently
              assigned to it in Kandji.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
