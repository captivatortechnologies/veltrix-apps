import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'apikey',
      label: '1. API Key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Exabeam console, go to <strong>Settings &gt; API Keys</strong> and create a new
              key. Give it a descriptive name and assign it a permission set that covers{' '}
              <strong>Correlation Rules</strong> (read/write).
            </p>
            <p>
              Copy the generated <strong>Key</strong> and <strong>Secret</strong> immediately - both
              are shown only once, in plain text.
            </p>
            <p>
              Exabeam's own guidance: tokens minted from this key are valid for about 4 hours, and the
              key is capped at roughly 6 token requests per 24 hours - this app respects that by
              caching the token for its full lifetime rather than re-authenticating per request.
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
            <p>Store the API Key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the API Key
              </li>
              <li>
                <strong>API token</strong> - the API Key Secret
              </li>
            </ul>
            <p>
              The app exchanges these for a short-lived access token via the OAuth2{' '}
              <code>client_credentials</code> grant against <code>/auth/v1/token</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & Region',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>exabeam-tenant</strong> component and attach the credential. Exabeam
              has no per-tenant id in its API URLs - the tenant is fully identified by the API Key
              itself - so the component's endpoint/hostname is never read by this app; any short,
              non-blank label works (the platform still needs one to create the deploy target).
            </p>
            <p>
              Set the app's <strong>Region</strong> setting to match where your Exabeam tenant is
              provisioned (US West / US East / Singapore / Japan / EU / Australia / Canada /
              Switzerland / South America / UK) - it does not auto-detect, and the wrong region will
              fail every request.
            </p>
            <p>
              Then author correlation rules in the Configuration Canvas and deploy them through the
              pipeline.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
