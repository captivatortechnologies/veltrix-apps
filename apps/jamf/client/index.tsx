import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'jamf',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/jamf/overview', label: 'Overview', icon: 'cloud' },
    { path: '/apps/jamf/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/jamf/connections', label: 'Connections', icon: 'link' },
  ],
}
