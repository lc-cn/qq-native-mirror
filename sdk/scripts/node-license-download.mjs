/** Bounded official Node LICENSE download. No writes or environment/auth access. */
import { createHash } from 'node:crypto';
// Official Git blobs: v24.19.0 2842efa1288eef1de3a6778b5dd3519bc903308d;
// v24.20.0 9cc3315dd388a004c225620b30c5806bba3151d5.
const LICENSE_SHA256 = Object.freeze({
  'v24.19.0': '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5',
  'v24.20.0': '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace',
});
function cancel(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }
const MAX_BYTES = 2 * 1024 * 1024;
class InvalidLicense extends Error {}
function fail(message) { throw new InvalidLicense(message); }
function transport(error) {
  return error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.code ?? error?.cause?.code);
}
function validate(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Node license is not UTF-8'); }
  if (!text.startsWith('Node.js is licensed for use as follows:\n') || /<!doctype\s+html|<html[\s>]/i.test(text) ||
      !text.includes('Copyright Node.js contributors. All rights reserved.') ||
      !text.includes('Permission is hereby granted, free of charge') ||
      !text.includes('THE SOFTWARE IS PROVIDED "AS IS"') ||
      !text.includes('This license applies to parts of Node.js originating from the') ||
      !text.trimEnd().endsWith('"""')) fail('Invalid Node license document');
  return bytes;
}
export async function downloadNodeLicense(nodeVersion, {
  fetch: fetchImpl = globalThis.fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxBytes = MAX_BYTES,
  timeoutMs = 30_000,
  expectedSha256 = LICENSE_SHA256[nodeVersion],
} = {}) {
  if (typeof nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new TypeError('Invalid Node version');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || typeof fetchImpl !== 'function' || typeof wait !== 'function') throw new TypeError('Invalid Node license download options');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new TypeError('Trusted Node license SHA-256 required');
  const url = `https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let reader, timer;
    const controller = new AbortController();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('Node license download timed out'); error.name = 'TimeoutError'; reject(error); }, timeoutMs); });
    try {
      const request = (async () => {
        const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) { cancel(response.body); const error = new Error('Download expired'); error.name = 'TimeoutError'; throw error; }
        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          cancel(response.body); const error = new Error('Retryable Node license HTTP status'); error.retryableHttp = true; throw error;
        }
        if (response.status !== 200) { cancel(response.body); fail('Node license HTTP request rejected'); }
        if (!response.body) fail('Node license body missing');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { cancel(response.body); fail('Node license body exceeds limit'); }
        reader = response.body.getReader(); let size = 0; const parts = [];
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > maxBytes) fail('Node license body exceeds limit'); parts.push(Buffer.from(value));
        }
        // Fetch decodes Content-Encoding, while Content-Length counts encoded bytes.
        const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
        if ((!encoding || encoding === 'identity') && declared !== null && Number(declared) !== size) fail('Node license body length mismatch');
        const bytes = validate(Buffer.concat(parts));
        if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) fail('Node license SHA-256 mismatch');
        return bytes;
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof InvalidLicense || !(error?.retryableHttp || transport(error)) || attempt === 2) throw new Error('Node license download failed');
    } finally {
      clearTimeout(timer); controller.abort(); if (reader) cancel(reader);
    }
    await wait(250 * (attempt + 1));
  }
}
