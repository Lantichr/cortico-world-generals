import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** One in-flight JSONL request; termination rejects pending work and waits for process exit. */
export class PythonChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private buffer = '';
  private stderr = '';
  private sequence = 0;
  private failure: Error | null = null;
  private pending: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(executable: string, script: string, private readonly timeoutMs: number) {
    this.child = spawn(executable, ['-I', '-u', '-B', script], { windowsHide: true, stdio: 'pipe' });
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code, signal) => this.fail(new Error(`Python exited (${code ?? signal}): ${this.stderr}`)));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (data: string) => { this.stderr = (this.stderr + data).slice(-8192); });
    this.child.stdout.on('data', (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) { this.fail(new Error('Python response exceeds size limit')); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Python response');
          const reply = value as Record<string, unknown>;
          const pending = this.pending;
          if (!pending || reply.id !== pending.id) throw new Error('Unexpected Python response id');
          if (reply.error) throw new Error(`Python backend: ${String(reply.error)}`);
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(reply);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  }

  request(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Python request already pending'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Python request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ ...value, id }) + '\n');
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.child.kill();
  }

  close(): Promise<void> {
    this.fail(new Error('Python backend stopped'));
    return this.exited;
  }
}
