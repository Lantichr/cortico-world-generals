import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GeneralsViewerSnapshot } from './contracts.ts';

const HOST = '127.0.0.1';
const STATIC_DIR = new URL('./web/', import.meta.url);
const STATIC_FILES: Record<string, { file: string; mime: string }> = {
  '/viewer': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/viewer/app.js': { file: 'app.js', mime: 'text/javascript; charset=utf-8' },
  '/viewer/styles.css': { file: 'styles.css', mime: 'text/css; charset=utf-8' },
};
const KEEPALIVE_MS = 15_000;

interface ViewerOptions {
  preferredPort: number;
  snapshot: () => GeneralsViewerSnapshot;
}

interface Subscriber {
  response: ServerResponse;
  pending: string | null;
}

/** The loopback viewer exposes current observations and submitted moves through read-only HTTP. */
export class GeneralsViewerServer {
  private http: Server | null = null;
  private boundPort: number | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly options: ViewerOptions) {}

  get viewerUrl(): string {
    return `${this.baseUrl}/viewer`;
  }

  get running(): boolean {
    return this.http !== null;
  }

  get port(): number | null {
    return this.boundPort;
  }

  private get baseUrl(): string {
    return `http://${HOST}:${this.boundPort ?? this.options.preferredPort}`;
  }

  async start(): Promise<void> {
    if (this.http) return;
    const server = createServer((request, response) => {
      try {
        this.onRequest(request, response);
      } catch {
        if (response.headersSent) response.destroy();
        else this.text(response, 500, 'viewer unavailable');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.preferredPort, HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.boundPort = (server.address() as AddressInfo).port;
    this.http = server;
    this.keepalive = setInterval(() => {
      for (const subscriber of this.subscribers) {
        if (!subscriber.response.writableNeedDrain) subscriber.response.write(':hb\n\n');
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const subscriber of this.subscribers) subscriber.response.end();
    this.subscribers.clear();
    const server = this.http;
    this.http = null;
    this.boundPort = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  publish(): void {
    if (!this.subscribers.size) return;
    const frame = this.frame();
    for (const subscriber of this.subscribers) {
      if (subscriber.response.writableNeedDrain) subscriber.pending = frame;
      else subscriber.response.write(frame);
    }
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!this.sameOrigin(request)) {
      this.text(response, 403, 'viewer only accepts same-origin requests');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      this.text(response, 405, 'GET only');
      return;
    }
    const path = new URL(request.url ?? '/', this.baseUrl).pathname;
    const asset = STATIC_FILES[path];
    if (asset) {
      const body = readFileSync(new URL(asset.file, STATIC_DIR));
      response.writeHead(200, {
        ...this.headers(asset.mime),
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
      }).end(body);
      return;
    }
    if (path === '/api/state') {
      response.writeHead(200, this.headers('application/json; charset=utf-8'))
        .end(JSON.stringify(this.options.snapshot()));
      return;
    }
    if (path !== '/stream') {
      this.text(response, 404, 'viewer resource not found');
      return;
    }
    const frame = this.frame();
    response.writeHead(200, {
      ...this.headers('text/event-stream; charset=utf-8'),
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write(frame);
    const subscriber: Subscriber = { response, pending: null };
    this.subscribers.add(subscriber);
    response.on('close', () => this.subscribers.delete(subscriber));
    response.on('drain', () => {
      if (subscriber.pending === null) return;
      const pending = subscriber.pending;
      subscriber.pending = null;
      response.write(pending);
    });
  }

  private sameOrigin(request: IncomingMessage): boolean {
    return request.headers.host === new URL(this.baseUrl).host
      && (request.headers.origin === undefined || request.headers.origin === this.baseUrl)
      && request.headers['sec-fetch-site'] !== 'cross-site';
  }

  private frame(): string {
    return `data: ${JSON.stringify(this.options.snapshot())}\n\n`;
  }

  private headers(mime: string): Record<string, string> {
    return {
      'Content-Type': mime,
      'Cache-Control': 'no-cache, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
  }

  private text(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, this.headers('text/plain; charset=utf-8')).end(text);
  }
}
