import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { k } from '@pkg/locales';
import { serversApi } from '@/shared/servers/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Phase = 'connecting' | 'open' | 'closed' | 'error';

/**
 * An interactive shell on a server.
 *
 * xterm.js is mounted directly rather than through a React wrapper: the
 * wrappers are thin, go stale, and the imperative lifecycle here (attach to a
 * div, dispose on unmount) is not a good fit for rendering anyway.
 *
 * Bytes go over the socket raw in both directions. Only resize is a control
 * message, and it matters more than it looks — without it every full-screen
 * program (htop, vim, less) draws to the wrong dimensions.
 */
export function ServerTerminalDialog({
  serverId,
  serverName,
  open,
  onOpenChange,
}: {
  serverId: string;
  serverName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  // A callback ref, not useRef: the dialog renders through a portal, so on the
  // first effect pass a ref object is still null — the effect would return
  // early and never run again, because a ref does not re-trigger effects. This
  // makes the node's arrival the thing that starts the session.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [remaining, setRemaining] = useState<string>('');

  // The countdown is the whole point of a self-closing window: a session that
  // expires silently just looks like a broken terminal.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = (): void => {
      const ms = expiresAt.getTime() - Date.now();
      if (ms <= 0) {
        setRemaining('0:00');
        return;
      }
      const total = Math.floor(ms / 1000);
      setRemaining(`${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const connect = useCallback(async () => {
    if (!host) return undefined;

    setPhase('connecting');
    setDetail(null);

    let issued: { ticket: string; expiresAt: string };
    try {
      issued = await serversApi.openShell(serverId);
    } catch (error) {
      setPhase('error');
      setDetail((error as Error).message);
      return undefined;
    }
    setExpiresAt(new Date(issued.expiresAt));

    const term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0b0d' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const wsUrl = new URL('/api/servers/shell', window.location.origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('ticket', issued.ticket);
    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';

    const sendResize = (): void => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    socket.onopen = () => {
      setPhase('open');
      // A frame later: the dialog animates in, and fitting against a
      // half-sized container leaves xterm at its 80x24 default while the
      // remote pty believes the same — every full-screen program then draws
      // to the wrong box.
      requestAnimationFrame(() => sendResize());
      term.focus();
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      term.write(
        typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    socket.onclose = (event) => {
      setPhase('closed');
      if (event.code === 4401) setDetail(t(k.servers.errors.shellExpired));
      term.write('\r\n\x1b[90m— session ended —\x1b[0m\r\n');
    };
    socket.onerror = () => setPhase('error');

    const typed = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data));
      }
    });

    const observer = new ResizeObserver(() => sendResize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      typed.dispose();
      socket.close();
      term.dispose();
    };
  }, [serverId, t, host]);

  useEffect(() => {
    if (!open || !host) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void connect().then((fn) => {
      if (cancelled) fn?.();
      else cleanup = fn;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [open, host, connect]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t(k.servers.terminalTitle, { name: serverName })}</DialogTitle>
          <DialogDescription>
            {phase === 'open' && remaining
              ? t(k.servers.terminalExpiresIn, { time: remaining })
              : t(k.servers.terminalHint)}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={setHost}
          className="h-[26rem] w-full overflow-hidden rounded-md bg-[#0b0b0d] p-2"
          data-testid="server-terminal"
        />
        {detail && <p className="text-xs text-destructive">{detail}</p>}
      </DialogContent>
    </Dialog>
  );
}
