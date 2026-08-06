import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'kandji',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/kandji/overview', label: 'Overview', icon: 'cloud' },
    { path: '/apps/kandji/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/kandji/connections', label: 'Connections', icon: 'link' },
  ],
}
