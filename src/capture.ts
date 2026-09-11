import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const MAX_BYTES = 5 * 1024 * 1024;

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export async function publicTarget(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials can be captured.');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only standard web ports are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error('Private, loopback, link-local, and reserved network destinations are blocked.');
  }
  return { url, address: addresses[0] };
}

interface Response {
  status: number;
  location?: string;
  body: string;
  contentType: string;
  challenge: boolean;
}

// DNS is resolved and checked once per hop, then pinned to the actual connection.
export async function fetchPage(
  raw: string,
  redirects = 0,
  deadline = Date.now() + 20_000,
): Promise<{ url: string; body: string; contentType: string }> {
  if (process.env.MEMLIO_OFFLINE === '1') throw new Error('Page capture is disabled by MEMLIO_OFFLINE=1.');
  if (redirects > 5) throw new Error('Too many redirects.');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Page capture timed out.');
  let timer: NodeJS.Timeout | undefined;
  const target = await Promise.race([
    publicTarget(raw),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
  const { url, address } = target;
  const response = await new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(
      url,
      {
        headers: {
          'User-Agent': 'memlio/0.1 (personal bookmark capture)',
          Accept: 'text/html,text/plain,application/xhtml+xml',
          'Accept-Encoding': 'identity',
        },
        lookup: ((_host: unknown, opts: { all?: boolean }, callback: Function) =>
          opts.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
      },
      (res) => {
        const status = res.statusCode ?? 500;
        const challenge =
          Boolean(res.headers['cf-mitigated']) || (status === 403 && /cloudflare/i.test(String(res.headers.server ?? '')));
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, body: '', contentType: '', challenge });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            new Error(
              challenge
                ? `The site blocked automated capture (HTTP ${status} bot challenge). The bookmark is saved; add a note describing the page to make it findable.`
                : status === 401 || status === 403
                  ? `The page requires a login or blocks non-browser clients (HTTP ${status}). The bookmark is saved without a snapshot.`
                  : `Page returned HTTP ${status}.`,
            ),
          );
          return;
        }
        const contentType = res.headers['content-type'] ?? '';
        if (!/^(text\/(html|plain)|application\/xhtml\+xml)/i.test(contentType)) {
          res.resume();
          reject(new Error(`Unsupported page content type: ${contentType || 'unknown'}.`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy(new Error('Page exceeds the 5 MB capture limit.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), contentType, challenge }));
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error('Page capture timed out.')), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
  });
  if (response.status >= 300 && response.status < 400) {
    if (!response.location) throw new Error('Redirect has no destination.');
    return fetchPage(new URL(response.location, url).href, redirects + 1, deadline);
  }
  return { url: url.href, body: response.body, contentType: response.contentType };
}

export function extractPage(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  // Parse only: linkedom does not fetch resources or run page scripts.
  const base = document.createElement('base');
  base.href = url;
  document.head.prepend(base);
  const fallbackTitle = document.title || new URL(url).hostname;
  const article = new Readability(document as unknown as Document).parse();
  if (!article?.content || !article.textContent?.trim()) {
    throw new Error(
      'No readable article text was found (the page may need JavaScript or a login). The bookmark is saved without a snapshot.',
    );
  }
  const clean = parseHTML(article.content).document;
  for (const el of clean.querySelectorAll('script,style,iframe,form,object,embed')) el.remove();
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(clean.toString());
  return { title: article.title || fallbackTitle, markdown };
}
