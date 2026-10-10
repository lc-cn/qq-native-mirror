import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadNodeLicense as actualDownload } from '../scripts/node-license-download.mjs';
const document =
  'Node.js is licensed for use as follows:\n"""\nCopyright Node.js contributors. All rights reserved.\nPermission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"\n"""\nThis license applies to parts of Node.js originating from the\n"""\nThird-party owned fixture\n"""\n';
// Owned synthetic license and explicit test digest; never a claim of official content.
const fixtureSha = createHash('sha256').update(document).digest('hex');
const downloadNodeLicense = (version, options = {}) =>
  actualDownload(version, { expectedSha256: fixtureSha, ...options });
const response = () => new Response(document);
test('official fixed URL, no redirects, returns captured bytes', async () => {
  const bytes = await downloadNodeLicense('v24.20.0', {
    fetch: async (url, options) => {
      assert.equal(url, 'https://raw.githubusercontent.com/nodejs/node/v24.20.0/LICENSE');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    },
  });
  assert.equal(bytes.toString(), document);
});
test('transport, 429 and 5xx get at most three attempts', async () => {
  for (const kind of ['transport', 429, 503]) {
    let calls = 0;
    const waits = [];
    await assert.rejects(
      downloadNodeLicense('v24.20.0', {
        fetch: async () => {
          calls++;
          if (kind === 'transport') throw new TypeError('fetch failed');
          return new Response('', { status: kind });
        },
        wait: async (ms) => waits.push(ms),
      }),
      /download failed/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [250, 500]);
  }
  let calls = 0;
  assert.equal(
    (
      await downloadNodeLicense('v24.20.0', {
        fetch: async () => (++calls === 1 ? new Response('', { status: 503 }) : response()),
        wait: async () => {},
      })
    ).toString(),
    document,
  );
  assert.equal(calls, 2);
});
test('permanent HTTP, bad/oversized/truncated license fail once', async () => {
  for (const make of [
    () => new Response('', { status: 404 }),
    () => new Response('<html>no</html>'),
    () => new Response(document.slice(0, -8)),
    () => new Response(document, { headers: { 'content-length': '9999999' } }),
    () => new Response(document, { headers: { 'content-length': '1' } }),
    () => new Response(document + 'x'.repeat(1024)),
  ]) {
    let calls = 0;
    await assert.rejects(
      downloadNodeLicense('v24.20.0', {
        maxBytes: 512,
        fetch: async () => {
          calls++;
          return make();
        },
        wait: async () => assert.fail('must not retry'),
      }),
    );
    assert.equal(calls, 1);
  }
});
test('invalid version/options reject before fetch and arbitrary failure does not retry', async () => {
  for (const version of ['24.20.0', 'v24.20.0/../main', 'v24.20.0-beta', null])
    await assert.rejects(
      downloadNodeLicense(version, { fetch: () => assert.fail('dispatch') }),
      /Invalid Node version/,
    );
  await assert.rejects(
    downloadNodeLicense('v24.20.0', { maxBytes: Infinity, fetch: () => assert.fail('dispatch') }),
  );
  let calls = 0;
  await assert.rejects(
    downloadNodeLicense('v24.20.0', {
      fetch: async () => {
        calls++;
        throw new Error('private arbitrary data');
      },
      wait: () => assert.fail('retry'),
    }),
    /^Error: Node license download failed$/,
  );
  assert.equal(calls, 1);
});
test('deadline bounds pending fetch and observes late rejection', async () => {
  let calls = 0;
  await assert.rejects(
    downloadNodeLicense('v24.20.0', {
      timeoutMs: 5,
      fetch: () => {
        calls++;
        return new Promise((_, reject) =>
          setTimeout(() => reject(new TypeError('late transport')), 20),
        );
      },
      wait: async () => {},
    }),
    /download failed/,
  );
  assert.equal(calls, 3);
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test('official default pins reject synthetic content; unknown versions need trusted pin', async () => {
  let calls = 0;
  await assert.rejects(
    actualDownload('v24.20.0', {
      fetch: async () => {
        calls++;
        return response();
      },
      wait: () => assert.fail('hash failure retry'),
    }),
    /download failed/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    actualDownload('v99.0.0', { fetch: () => assert.fail('untrusted version dispatch') }),
    /Trusted Node license SHA/,
  );
  await assert.rejects(
    downloadNodeLicense('v24.20.0', {
      expectedSha256: 'x',
      fetch: () => assert.fail('invalid hash dispatch'),
    }),
    /Trusted Node license SHA/,
  );
});
test('deadline does not await a stalled body cancellation', async () => {
  let calls = 0;
  await assert.rejects(
    downloadNodeLicense('v24.20.0', {
      timeoutMs: 5,
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              return new Promise(() => {});
            },
          }),
        );
      },
      wait: async () => {},
    }),
    /download failed/,
  );
  assert.equal(calls, 3);
});

test('decoded compressed HTTP body is checked by decoded bound and SHA, not encoded length', async () => {
  for (const encoding of ['gzip', 'br']) {
    let calls = 0;
    const bytes = await downloadNodeLicense('v24.20.0', {
      fetch: async () => {
        calls++;
        return new Response(document, {
          headers: { 'content-encoding': encoding, 'content-length': '20' },
        });
      },
    });
    assert.equal(bytes.toString(), document);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(
      downloadNodeLicense('v24.20.0', {
        fetch: async () => {
          calls++;
          return new Response(
            document.replace('Third-party owned fixture', 'Changed owned fixture'),
            { headers: { 'content-encoding': encoding, 'content-length': '20' } },
          );
        },
        wait: () => assert.fail('SHA mismatch must not retry'),
      }),
      /download failed/,
    );
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(
      downloadNodeLicense('v24.20.0', {
        maxBytes: 128,
        fetch: async () => {
          calls++;
          return new Response(document, {
            headers: { 'content-encoding': encoding, 'content-length': '20' },
          });
        },
        wait: () => assert.fail('decoded overflow must not retry'),
      }),
      /download failed/,
    );
    assert.equal(calls, 1);
  }
});
