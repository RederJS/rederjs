import { SessionList } from './pages/SessionList';
import { SessionDetail } from './pages/SessionDetail';
import { parseRoute, useHashRoute } from './router';

export function App(): JSX.Element {
  const route = useHashRoute();
  const parsed = parseRoute(route);

  if (parsed.page === 'detail' && parsed.sessionId) {
    return <SessionDetail sessionId={parsed.sessionId} />;
  }
  return <SessionList />;
}
