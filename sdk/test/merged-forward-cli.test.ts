import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareCommand, formatCliError } from '../src/cli.ts';
import { MergedForwardError, deserializeKernelError, serializeKernelError } from '../src/errors.ts';
const nodes = [{ userId: '456', nickname: 'fixture', time: 100, text: 'text ✓' }];
async function directory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'qq-forward-cli-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('CLI validates complete JSON before producing an action and passes exact peer/nodes/options', async () => directory(async root => {
  const file = join(root, 'nodes.json'); await writeFile(file, JSON.stringify(nodes));
  let calls = 0;
  const action = await prepareCommand('send-forward', { kind: 'group', target: '123', 'nodes-file': file, title: 'title', summary: 'summary', prompt: 'prompt' });
  assert.equal(calls, 0);
  const receipt = { messageId: '42', sequence: '9', time: 100, resourceId: 'r' };
  assert.deepEqual(await action({ sendMergedForward: async (...args: unknown[]) => {
    calls++; assert.deepEqual(args, [{ type: 'group', groupId: '123' }, nodes, { title: 'title', summary: 'summary', prompt: 'prompt' }]); return receipt;
  } } as any), receipt);
  assert.equal(calls, 1);
}));

test('CLI refuses malformed/empty/media/invalid-later-node and oversized JSON before fake client is callable', async () => directory(async root => {
  const file = join(root, 'nodes.json'); let calls = 0;
  for (const content of ['{', '[]', '[null]', JSON.stringify([{ ...nodes[0], image: 'unsupported' }]), JSON.stringify([nodes[0], { ...nodes[0], time: 0 }]), ' '.repeat(2 * 1024 * 1024 + 1), Buffer.concat([Buffer.from('[{"userId":"456","nickname":"fixture","time":100,"text":"'), Buffer.from([0xff]), Buffer.from('"}]')])]) {
    await writeFile(file, content);
    await assert.rejects(async () => {
      const action = await prepareCommand('send-forward', { kind: 'private', target: '456', 'nodes-file': file });
      await action({ sendMergedForward: async () => { calls++; } } as any);
    });
  }
  assert.equal(calls, 0);
}));

test('CLI captures flags and file nodes so later file/flag mutations cannot alter action', async () => directory(async root => {
  const file = join(root, 'nodes.json'); await writeFile(file, JSON.stringify(nodes));
  const flags = { kind: 'private', target: '456', 'nodes-file': file, title: 'original' };
  const action = await prepareCommand('send-forward', flags);
  flags.target = '999'; flags.title = 'mutated'; await writeFile(file, JSON.stringify([{ ...nodes[0], text: 'mutated' }]));
  await action({ sendMergedForward: async (...args: unknown[]) => assert.deepEqual(args, [{ type: 'private', userId: '456' }, nodes, { title: 'original' }]) } as any);
}));

test('CLI formats bounded partial scope/code without serializing cause, stack or arbitrary native token', () => {
  const error = Object.assign(new MergedForwardError('card', 'Merged-forward card sending failed', { uploadCompletion: 'resource-received', cardCompletion: 'unknown', resourceId: 'r' }, 23), { cause: Error('private cause'), token: 'private token' });
  const expected = { error: error.message, mergedForward: { phase: 'card', uploadCompletion: 'resource-received', cardCompletion: 'unknown', resourceId: 'r' }, code: 23 };
  for (const value of [error, deserializeKernelError('sendMergedForward', serializeKernelError(error))]) {
    const output = formatCliError(value); assert.deepEqual(JSON.parse(output), expected);
    assert.ok(!output.includes('private')); assert.ok(!output.includes('stack')); assert.ok(!output.includes('cause'));
  }
});
