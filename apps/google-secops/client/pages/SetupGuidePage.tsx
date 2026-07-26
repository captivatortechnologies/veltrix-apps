import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide for the Google Security Operations app, rendered
 * with the platform design-system components from @veltrixsecops/app-sdk/ui — the
 * same Tabs / Card the built-in platform screens use, themed to the app's brand
 * color. SecOps authenticates with a Google service account.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'sa',
      label: '1. Service account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Google Cloud, create (or reuse) a <strong>service account</strong> that is granted
              the Google SecOps / Chronicle API access for reference lists. Create a{' '}
              <strong>JSON key</strong> for it and download the key file — it contains the private key
              used to mint access tokens.
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
            <p>Store the service-account key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Password</strong> → the entire service-account JSON key (paste the whole file)
              </li>
            </ul>
            <p>
              The app builds and signs (RS256) a JWT with the key's private key and exchanges it for a
              short-lived Bearer token, refreshing it automatically. The key is stored encrypted at
              rest.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '3. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Set the app's settings:</p>
            <ul>
              <li>
                <strong>Region</strong> → your SecOps region (e.g. <code>us</code>,{' '}
                <code>europe-west2</code>).
              </li>
              <li>
                <strong>Project ID</strong> → the Google Cloud project id.
              </li>
              <li>
                <strong>Instance ID</strong> → your SecOps customer/instance GUID.
              </li>
            </ul>
            <p>
              Then on the <strong>Connections</strong> page create a{' '}
              <strong>google-secops</strong> connection, attach the credential, and{' '}
              <strong>Test</strong> it. Author a configuration in the Configuration Canvas and deploy
              it — reference lists are matched by their id and their entries reconciled to exactly the
              declared list. Note that reference lists cannot be deleted, only emptied.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
