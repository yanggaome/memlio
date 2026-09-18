import { z } from 'zod';
import { VERSION, errorText } from './config.js';
import { Memory, summarize } from './store.js';

/** Chrome's limit on one reply from a native messaging host. */
const REPLY_LIMIT = 1024 * 1024;
/** Chrome allows far larger requests; this bound keeps one bad frame from exhausting memory. */
const REQUEST_LIMIT = 64 * 1024 * 1024;
export const HOST_NAME = 'com.memlio.host';

const request = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({
    type: z.literal('store'),
    url: z.string().max(8192),
    title: z.string().max(500).optional(),
    note: z.string().max(20_000).optional(),
    html: z.string().max(5_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    /** A base64 PNG, at most 20 MB decoded. */
    screenshot: z.string().max(28_000_000).optional(),
  }),
]);
export type NativeRequest = z.infer<typeof request>;

/** One native messaging frame: a little-endian 32-bit byte length followed by UTF-8 JSON. */
export function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Splits every complete frame out of `buffer`; the remainder starts the next read. */
export function decode(buffer: Buffer, limit = REQUEST_LIMIT): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > limit) throw new Error(`A ${length} byte message exceeds the ${limit} byte limit.`);
    if (buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** Answers one request from the extension. Page content is data from the browser, never instructions. */
export async function handle(memory: Memory, raw: unknown) {
  const parsed = request.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid request.');
  const message = parsed.data;
  if (message.type === 'status') {
    const status = memory.status();
    return { ok: true as const, version: VERSION, home: status.home, count: status.count };
  }
  // The page's own title wins when there is a snapshot; the tab title is its fallback.
  const page =
    message.html !== undefined || message.text !== undefined
      ? { html: message.html ?? '', text: message.text, title: message.title }
      : undefined;
  const saved = await memory.store({
    input: message.url,
    kind: 'url',
    title: page ? undefined : message.title,
    note: message.note,
    source: 'chrome',
    page,
    screenshot: message.screenshot ? Buffer.from(message.screenshot, 'base64') : undefined,
  });
  return { ok: true as const, ...summarize(saved) };
}

/** Serve the Chrome extension over stdio until Chrome closes the pipe. */
export async function serveChrome(home: string) {
  // Only frames may reach stdout; anything a library prints goes to stderr instead.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  if (process.stdin.isTTY)
    console.error('memlio chrome-host: started by Chrome normally; waiting for frames on stdin (Ctrl+C to stop).');
  const memory = new Memory(home);
  let buffer: Buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  const reply = (value: unknown) => {
    const frame = encode(value);
    process.stdout.write(frame.length > REPLY_LIMIT ? encode({ ok: false, error: 'Reply too large.' }) : frame);
  };
  const respond = (raw: unknown) => {
    queue = queue.then(async () => {
      try {
        reply(await handle(memory, raw));
      } catch (e) {
        reply({ ok: false, error: errorText(e) });
      }
    });
  };
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      const decoded = decode(buffer);
      buffer = decoded.rest;
      decoded.messages.forEach(respond);
    } catch (e) {
      // A corrupt or oversized frame cannot be resynchronised; report it and stop reading.
      reply({ ok: false, error: errorText(e) });
      process.stdin.destroy();
    }
  });
  await new Promise<void>((resolve) => process.stdin.once('close', resolve));
  await queue;
  await memory.close();
}
