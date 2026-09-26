import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { SignupPage } from './features/auth/SignupPage';
import { AdminPage } from './features/admin/AdminPage';
import { HomePage } from './features/home/HomePage';
import { LibraryPage } from './features/library/LibraryPage';
import { DiagramsPage } from './features/diagrams/DiagramsPage';
import { MemoryPage } from './features/memory/MemoryPage';
import { ReviewPage } from './features/review/ReviewPage';
import { ScopeChatPage } from './features/chat/ScopeChatPage';
import { SearchPage } from './features/search/SearchPage';
import { StatsPage } from './features/stats/StatsPage';
import { TrashPage } from './features/library/TrashPage';
import { ReaderPage } from './features/reader/ReaderPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { useApplyTheme } from './lib/theme';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:token', element: <SignupPage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'library/t/:topicId', element: <LibraryPage /> },
      { path: 'library/trash', element: <TrashPage /> },
      { path: 'read/:documentId', element: <ReaderPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'diagrams', element: <DiagramsPage /> },
      { path: 'review', element: <ReviewPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'chat/topic/:id', element: <ScopeChatPage kind="topic" /> },
      { path: 'chat/subject/:id', element: <ScopeChatPage kind="subject" /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
]);

export function App() {
  useApplyTheme();
  return <RouterProvider router={router} />;
}
