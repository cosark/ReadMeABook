/**
 * Component: E2E fake Audible / Audnexus metadata, served as an answering HTTP proxy (fake-arr:9898)
 * Documentation: documentation/testing/e2e-harness.md
 *
 * Used with `--overrides abs-fake-metadata`: Audiobookshelf and RMAB get HTTP(S)_PROXY pointing here.
 * axios sends an https target to an http proxy as a plain absolute-URI request, so this listener reads
 * the target host from the request line and answers itself. Nothing is ever forwarded: no real
 * provider is reached. Data comes from the fixture book index (offline fixtures: made-up titles);
 * every free-text field is synthetic.
 *   api.audible.<tld>  GET /1.0/catalog/products?title=&author=  → { products: [{ asin }] }
 *   api.audnex.us      GET /books/<ASIN>                         → Audnexus-shaped book (no image)
 *                      GET /authors?name=                        → []
 *   other Audible/Audnexus paths → 404; any other host or CONNECT → 403
 */

import dns from 'node:dns/promises';
import { sendJson, sendText } from './http-util.js';

const AUDIBLE_API = /^api\.audible\.(com|ca|co\.uk|com\.au|fr|de|co\.jp|it|in|es)$/;
const AUDIBLE_WEB = /^(www\.)?audible\.(com|ca|co\.uk|com\.au|fr|de|co\.jp|it|in|es)$/;
const AUDNEXUS = 'api.audnex.us';

/** Host the client asked for: absolute-URI request line first, Host header otherwise. */
export function targetOf(req) {
  try {
    const url = new URL(req.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // origin-form request: not proxied
  }
  return new URL(req.url, `http://${req.headers.host || 'unknown'}`);
}

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/** Fixture books whose title contains every title word of the query (≥3 chars). */
export function searchBooks(books, title) {
  const want = words(title);
  if (want.length === 0) return [];
  return Object.values(books).filter((b) => {
    const have = new Set(words(b.title));
    return want.every((w) => have.has(w));
  });
}

export function audnexusBook(book) {
  return {
    asin: book.asin,
    title: book.title,
    subtitle: '',
    authors: [{ name: book.author }],
    narrators: book.narrator ? [{ name: book.narrator }] : [],
    publisherName: 'E2E Synthetic Publishing',
    summary: `<p>Synthetic e2e summary for ${book.title}. Not a real book description.</p>`,
    description: `Synthetic e2e summary for ${book.title}.`,
    releaseDate: '2020-01-01T00:00:00.000Z',
    genres: [],
    language: 'english',
    runtimeLengthMin: book.runtimeMin || 60,
    formatType: 'unabridged',
    isAdult: false,
    region: 'us',
    rating: '4.0',
  };
}

let names; // Promise<Map ip -> service name>, resolved once from the stack DNS
async function clientName(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  names ??= (async () => {
    const map = new Map();
    for (const svc of ['abs', 'rmab']) {
      try {
        for (const { address: a } of await dns.lookup(svc, { all: true })) map.set(a, svc);
      } catch {
        // service not on this network (unit tests)
      }
    }
    return map;
  })();
  return (await names).get(ip) || ip;
}

export async function handleMetadata(state, req, res, entry) {
  const target = targetOf(req);
  const host = target.hostname.toLowerCase();
  entry.client = await clientName(req.socket.remoteAddress);
  entry.target = `${target.protocol}//${host}${target.pathname}`;
  entry.host = host;
  entry.path = target.pathname;
  entry.query = Object.fromEntries(target.searchParams.entries());

  const books = state.fixtureIndex.books || {};
  if (req.method !== 'GET') return sendText(res, 405, 'GET only');

  if (AUDIBLE_API.test(host)) {
    if (target.pathname === '/1.0/catalog/products') {
      const found = searchBooks(books, target.searchParams.get('title') || target.searchParams.get('keywords'));
      return sendJson(res, 200, { products: found.map((b) => ({ asin: b.asin })), total_results: found.length });
    }
    return sendJson(res, 404, { message: 'not faked' });
  }

  if (host === AUDNEXUS) {
    const m = target.pathname.match(/^\/books\/([A-Za-z0-9]{10})$/);
    if (m) {
      const book = Object.values(books).find((b) => b.asin.toUpperCase() === m[1].toUpperCase());
      return book ? sendJson(res, 200, audnexusBook(book)) : sendJson(res, 404, { error: 'Book not found' });
    }
    if (target.pathname === '/authors') return sendJson(res, 200, []);
    return sendJson(res, 404, { error: 'not faked' });
  }

  if (AUDIBLE_WEB.test(host)) return sendText(res, 404, 'not faked');

  return sendText(res, 403, `fake metadata proxy: ${host} is not a faked provider`);
}

/** CONNECT tunnels are refused (and recorded): the fake can only answer absolute-URI requests. */
export async function refuseConnect(state, req, socket) {
  const entry = state.record({ service: 'metadata', method: 'CONNECT', host: String(req.url).split(':')[0], path: '', query: {}, headers: { ...req.headers }, status: 403 });
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  entry.client = await clientName(socket.remoteAddress);
}
