import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRecordElement } from '../src/features/media/media-record.ts';
import { createVideoElement } from '../src/features/media/media-send.ts';

for (const kind of ['record', 'video'] as const) {
  for (const asynchronous of [false, true]) {
    test(`${kind} staging preserves exact request, receiver and source with ${asynchronous ? 'async' : 'sync'} port`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'media-staging-port-'));
      try {
        const bytes =
          kind === 'record'
            ? Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([1, 0, 7])])
            : Buffer.alloc(24);
        if (kind === 'video') {
          bytes.writeUInt32BE(24);
          bytes.write('ftyp', 4);
          bytes.write('isom', 8);
        }
        const fileName = kind === 'record' ? 'voice.silk' : 'video.mp4';
        const source = join(directory, fileName),
          destination = join(directory, 'cache', 'Ori', fileName);
        await writeFile(source, bytes);
        const thumbnail = Buffer.alloc(24);
        Buffer.from('89504e470d0a1a0a', 'hex').copy(thumbnail);
        thumbnail.write('IHDR', 12);
        thumbnail.writeUInt32BE(1, 16);
        thumbnail.writeUInt32BE(1, 20);
        let getters = 0,
          calls = 0,
          measurements = 0;
        const service = {
          get getRichMediaFilePathForGuild() {
            getters++;
            return function (this: unknown, request: unknown) {
              assert.equal(this, service);
              calls++;
              assert.deepEqual(request, {
                md5HexStr: createHash('md5').update(bytes).digest('hex'),
                fileName,
                elementType: kind === 'record' ? 4 : 5,
                elementSubType: 0,
                thumbSize: 0,
                needCreate: true,
                downloadType: 1,
                file_uuid: '',
              });
              return asynchronous ? Promise.resolve(destination) : destination;
            };
          },
        };
        const result =
          kind === 'record'
            ? await createRecordElement(source, service, {
                async getDuration(path) {
                  assert.equal(path, source);
                  measurements++;
                  return 0.12;
                },
              })
            : await createVideoElement(source, service, undefined, {
                async getVideoInfo(path) {
                  assert.equal(path, source);
                  measurements++;
                  return {
                    width: 1280,
                    height: 720,
                    duration: 0.4,
                    format: 'png',
                    image: thumbnail,
                  };
                },
              });
        assert.equal(getters, 2);
        assert.equal(calls, 1);
        assert.equal(measurements, 1);
        assert.deepEqual(await readFile(source), bytes);
        assert.deepEqual(await readFile(destination), bytes);
        if (kind === 'video') {
          assert.equal(result.videoElement.filePath, destination);
          assert.equal(result.videoElement.thumbWidth, 1280);
          assert.deepEqual(await readFile(result.videoElement.thumbPath.get(0)), thumbnail);
        } else assert.equal(result.pttElement.filePath, destination);
        // A typed port does not replace runtime validation of its returned path.
        const malformed = { getRichMediaFilePathForGuild: () => ({ path: destination }) };
        if (kind === 'record')
          await assert.rejects(
            createRecordElement(source, malformed as unknown as typeof service, {
              async getDuration() {
                return 0.12;
              },
            }),
            /staging path/,
          );
        else
          await assert.rejects(
            createVideoElement(source, malformed as unknown as typeof service, undefined, {
              async getVideoInfo() {
                return { width: 1, height: 1, duration: 0.4, format: 'png', image: thumbnail };
              },
            }),
            /staging path/,
          );
        assert.deepEqual(await readFile(source), bytes);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
