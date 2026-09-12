import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Reads the image on the system clipboard as PNG bytes. Injected into Memory so tests never touch the real clipboard. */
export type ClipboardReader = () => Promise<Buffer>;

export const NO_IMAGE = 'The clipboard does not hold an image. Copy a screenshot first (Cmd+Ctrl+Shift+4 on macOS).';

/** Width and height from a PNG header, or null when the bytes are not a PNG. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

type ExecError = Error & { code?: string | number };
const missing = (e: ExecError) => e.code === 'ENOENT';

/** Runs a command that writes the clipboard image to `target`, then returns the bytes. */
async function viaFile(target: string, command: string, args: string[]): Promise<Buffer> {
  await run(command, args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
  return readFileSync(target);
}

async function darwin(target: string): Promise<Buffer> {
  // The clipboard is read before the file is opened, so a text-only clipboard fails with AppleScript's own
  // error number (-1700, "can't make into expected type") and nothing is left open. The path is quoted for AppleScript.
  const quoted = target.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = [
    'set d to (the clipboard as «class PNGf»)',
    `set f to open for access POSIX file "${quoted}" with write permission`,
    'write d to f',
    'close access f',
  ];
  return viaFile(
    target,
    'osascript',
    script.flatMap((line) => ['-e', line]),
  ).catch((e: ExecError) => {
    throw new Error(/-1700|-1728|expected type/.test(e.message) ? NO_IMAGE : `Clipboard read failed: ${e.message}`);
  });
}

async function linux(): Promise<Buffer> {
  const options = { encoding: 'buffer' as const, timeout: TIMEOUT, maxBuffer: MAX_BUFFER };
  const tools: [string, string[]][] = [
    ['wl-paste', ['-t', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  let absent = 0;
  for (const [command, args] of tools) {
    try {
      return (await run(command, args, options)).stdout;
    } catch (e) {
      if (missing(e as ExecError)) absent++;
      // A present tool that exits non-zero has nothing of type image/png to give.
      else throw new Error(NO_IMAGE);
    }
  }
  throw new Error(`Clipboard capture needs wl-paste or xclip (${absent} not found).`);
}

async function windows(target: string): Promise<Buffer> {
  const script = `$i=Get-Clipboard -Format Image; if($i -eq $null){exit 3}; $i.Save('${target.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;
  return viaFile(target, 'powershell', ['-NoProfile', '-Command', script]).catch((e: ExecError) => {
    throw new Error(e.code === 3 ? NO_IMAGE : `Clipboard read failed: ${e.message}`);
  });
}

export const readClipboardImage: ClipboardReader = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memlio-clipboard-'));
  const target = join(directory, 'clipboard.png');
  try {
    let bytes: Buffer;
    if (process.platform === 'darwin') bytes = await darwin(target);
    else if (process.platform === 'linux') bytes = await linux();
    else if (process.platform === 'win32') bytes = await windows(target);
    else throw new Error(`Clipboard capture is not supported on ${process.platform}.`);
    if (!bytes.length) throw new Error(NO_IMAGE);
    return bytes;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
