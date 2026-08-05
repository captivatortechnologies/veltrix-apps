import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card the built-in
 * platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'key',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Tines, open your name / avatar in the top right and go to the tenant's API keys
              (Team Settings, or your personal API key page depending on your Tines plan) and create an
              <strong> API key</strong>. The key inherits the permissions of the user or team it was
              created under, so use one scoped to what this app should manage.
            </p>
            <p>
              Note your <strong>tenant domain</strong> too — e.g. <code>acme.tines.com</code> (Cloud) or
              your self-hosted domain. Every API call is per-tenant: <code>https://&lt;tenant-domain&gt;/api/v1/...</code>.
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
            <p>Store the key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Tines API key
              </li>
            </ul>
            <p>
              The app sends it as <code>Authorization: Bearer &lt;key&gt;</code> to your tenant's{' '}
              <code>/api/v1</code> base.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>tines-tenant</strong> component whose hostname is your tenant domain
              (e.g. <code>acme.tines.com</code>) and attach the credential.
            </p>
            <p>
              Then author any of <strong>Teams</strong>, <strong>Folders</strong>, <strong>Tags</strong>,{' '}
              <strong>Global Resources</strong>, <strong>Credentials</strong>,{' '}
              <strong>Story Settings</strong> or <strong>Team Members</strong> in the Configuration
              Canvas and deploy through the pipeline. Story Settings reconciles the settings of a story
              that already exists in Tines — author its graph in the Tines Story editor first.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
