import { useEffect, useRef } from 'react';

export type SseHandler = (event: string, data: unknown) => void;

export function useEventStream(url: string | null, handler: SseHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!url) return;
    const src = new EventSource(url, { withCredentials: true });

    const events = [
      'inbound',
      'outbound',
      'outbound.persisted',
      'permission.requested',
      'permission.resolved',
      'permission.cancelled',
      'session.state_changed',
    ];

    const listeners = events.map((name) => {
      const fn = (evt: MessageEvent<string>): void => {
        let data: unknown = evt.data;
        try {
          data = JSON.parse(evt.data) as unknown;
        } catch {
          // leave raw
        }
        handlerRef.current(name, data);
      };
      src.addEventListener(name, fn);
      return { name, fn };
    });

    return () => {
      for (const { name, fn } of listeners) {
        src.removeEventListener(name, fn);
      }
      src.close();
    };
  }, [url]);
}
