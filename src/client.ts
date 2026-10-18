import WebSocket from 'ws';

/** Engine.IO 4 WebSocket transport and Socket.IO default namespace, without binary events. */
export class GeneralsClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;

  constructor(
    private readonly onEvent: (name: string, args: unknown[]) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  get connected(): boolean { return this.ready; }

  async start(url: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
      let heartbeatMs = 0;
      let failureReason = '';
      const armHeartbeat = (): void => {
        this.clearHeartbeat();
        this.heartbeatTimer = setTimeout(() => {
          failureReason = 'Engine.IO heartbeat timed out';
          socket.terminate();
        }, heartbeatMs);
      };
      const timeout = setTimeout(() => fail(new Error('Connection timed out')), timeoutMs);
      const fail = (error: Error): void => {
        failureReason = error.message;
        clearTimeout(timeout);
        reject(error);
        socket.terminate();
      };
      socket.on('error', fail);
      socket.on('close', (_code, reason) => {
        clearTimeout(timeout);
        const wasReady = this.ready;
        this.ready = false;
        this.clearHeartbeat();
        reject(new Error('Connection closed before ready'));
        if (wasReady) this.onClose(failureReason || reason.toString() || 'Connection closed');
      });
      socket.on('message', (raw) => {
        try {
          const packet = raw.toString();
          if (packet.startsWith('0')) {
            const hello = JSON.parse(packet.slice(1));
            if (!Number.isFinite(hello.pingInterval) || hello.pingInterval <= 0
              || !Number.isFinite(hello.pingTimeout) || hello.pingTimeout <= 0) {
              throw new Error('Invalid Engine.IO heartbeat');
            }
            heartbeatMs = hello.pingInterval + hello.pingTimeout;
            armHeartbeat();
            socket.send('40');
          } else if (packet === '2') {
            socket.send('3');
            armHeartbeat();
          } else if (packet.startsWith('40')) {
            this.ready = true;
            clearTimeout(timeout);
            resolve();
          } else if (packet.startsWith('42')) {
            const event: unknown = JSON.parse(packet.slice(2));
            if (!Array.isArray(event) || typeof event[0] !== 'string') throw new Error('Invalid Socket.IO event');
            this.onEvent(event[0], event.slice(1));
          } else if (packet === '41' || packet === '1' || packet.startsWith('44')) {
            throw new Error('Server disconnected the namespace');
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  send(name: string, ...args: unknown[]): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Generals is disconnected; restart the World');
    this.socket.send('42' + JSON.stringify([name, ...args]));
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.terminate();
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
