/**
 * Relay connection for the sandboxed game frame.
 *
 * The socket is deliberately same-origin: FriendSDK's child document runs with
 * `connect-src 'self' https://rpc.mainnet.chain.robinhood.com`, so a relay on the page's
 * own origin is the only realtime transport the sandbox permits.
 */
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./shared/protocol.ts";

export type NetStatus = "connecting" | "online" | "offline";

export type Net = {
  send(message: ClientMessage): void;
  identify(friendId: bigint, codename: string): void;
  close(): void;
  readonly status: NetStatus;
  readonly latencyMs: number;
};

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export function relayUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/relay`;
}

export function createNet(handlers: {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: NetStatus) => void;
}): Net {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let status: NetStatus = "connecting";
  let latencyMs = 0;
  let identity: { friendId: string; codename: string } | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: NetStatus) => {
    if (status === next) return;
    status = next;
    handlers.onStatus(next);
  };

  const queue: ClientMessage[] = [];

  function flush() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (queue.length) socket.send(JSON.stringify(queue.shift()));
  }

  function connect() {
    if (closed) return;
    setStatus(attempt === 0 ? "connecting" : "connecting");
    let next: WebSocket;
    try {
      next = new WebSocket(relayUrl());
    } catch {
      scheduleRetry();
      return;
    }
    socket = next;

    next.onopen = () => {
      attempt = 0;
      setStatus("online");
      if (identity) {
        next.send(JSON.stringify({
          t: "hello", protocol: PROTOCOL_VERSION,
          friendId: identity.friendId, codename: identity.codename,
        } satisfies ClientMessage));
      }
      flush();
      pingTimer = setInterval(() => {
        if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ t: "ping", at: Date.now() }));
      }, 4000);
    };

    next.onmessage = event => {
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === "pong") {
        latencyMs = Math.max(0, Date.now() - message.at);
        return;
      }
      handlers.onMessage(message);
    };

    next.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      socket = null;
      if (closed) return;
      setStatus("offline");
      scheduleRetry();
    };

    next.onerror = () => { /* close always follows; retry is handled there. */ };
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  connect();

  return {
    send(message) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else if (queue.length < 32) queue.push(message);
    },
    identify(friendId, codename) {
      identity = { friendId: friendId.toString(), codename };
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          t: "hello", protocol: PROTOCOL_VERSION,
          friendId: identity.friendId, codename: identity.codename,
        } satisfies ClientMessage));
      }
    },
    close() {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
    get status() { return status; },
    get latencyMs() { return latencyMs; },
  };
}
