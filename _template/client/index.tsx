// =============================================================================
// App Client Entry Point
//
// Register your app's pages and sidebar items here.
// The platform dynamically loads this when the app is enabled.
// =============================================================================

import React from 'react'

// Lazy-load pages for code splitting
const Dashboard = React.lazy(() => import('./pages/Dashboard'))

export default {
  id: 'my-app',
  pages: {
    Dashboard,
  },
  sidebarItems: [
    {
      path: '/apps/my-app',
      label: 'My App',
      icon: 'shield',
    },
  ],
}
