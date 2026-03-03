'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { boardService } from '@/lib/boardService';
import { useBoardStore } from '@/store/boardStore';

interface Props {
  boardId: string;
}

const MAX_FAILS = 5;

export default function ConnectionBanner({ boardId }: Props) {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'failed'>('connected');
  const [dismissed, setDismissed] = useState(false);
  const failCount = useRef(0);
  const setElements = useBoardStore((state) => state.setElements);

  const resync = useCallback(async () => {
    try {
      const elements = await boardService.getBoardElements(boardId);
      setElements(elements);
    } catch {
      // Ignore resync errors — the socket will push updates as they arrive
    }
  }, [boardId, setElements]);

  useEffect(() => {
    const socket = getSocket();

    const handleDisconnect = () => {
      failCount.current = 0;
      setStatus('reconnecting');
      setDismissed(false);
    };

    const handleConnect = () => {
      failCount.current = 0;
      setStatus('connected');
      resync();
    };

    const handleReconnectAttempt = () => {
      failCount.current += 1;
      if (failCount.current >= MAX_FAILS) {
        setStatus('failed');
      }
    };

    socket.on('disconnect', handleDisconnect);
    socket.on('connect', handleConnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);

    return () => {
      socket.off('disconnect', handleDisconnect);
      socket.off('connect', handleConnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
    };
  }, [resync]);

  if (status === 'connected' || dismissed) return null;

  return (
    <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20">
      <div
        className={`flex items-center gap-3 px-4 py-2 rounded-lg shadow-lg text-sm font-medium text-white ${
          status === 'failed' ? 'bg-red-600' : 'bg-yellow-500'
        }`}
      >
        {status === 'reconnecting' && (
          <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
        <span>
          {status === 'reconnecting'
            ? 'Connection lost \u2014 reconnecting\u2026'
            : 'Connection lost \u2014 please refresh'}
        </span>
        <button
          className="ml-2 opacity-70 hover:opacity-100"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss banner"
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}
