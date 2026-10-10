import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

// Child isolates process-level unhandled rejection observation from node:test's
// own listeners. No addon is loaded: all services are ordinary fake objects.
for (const operation of ['getHistory', 'getMessage', 'getMessages', 'uidLookup']) {
  test(`${operation}: synchronous native close observes a deliberately late rejection`, () => {
    const source = new URL('../src/native-services.ts', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { createNativeServices } from ${JSON.stringify(source)};
      let services, rejectLate, calls = 0, unhandled = 0;
      process.on('unhandledRejection', () => { unhandled++; });
      const native = () => {
        calls++; services.close();
        return new Promise((_resolve, reject) => { rejectLate = reject; });
      };
      const uid = ${JSON.stringify(operation)} === 'uidLookup';
      services = createNativeServices({ session: {
        getMsgService: () => ({ addKernelMsgListener() {}, getMsgsIncludeSelf: native, getMsgsByMsgId: native }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getUixConvertService: () => ({ getUid: native }),
      }, version: '7.0.2-53644', events: { emit: () => {} } });
      const method = uid ? 'getHistory' : ${JSON.stringify(operation)};
      const peer = uid ? {type:'private',userId:'456'} : {type:'group',groupId:'123'};
      const result = services.invokeOperation(method, {peer,messageId:'42',messageIds:['42']});
      await assert.rejects(result, /closed|abort/i);
      assert.equal(calls, 1);
      rejectLate(new Error('late synthetic rejection'));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(unhandled, 0);
      await assert.rejects(services.invokeOperation(method, {peer,messageId:'42',messageIds:['42']}), /closed/);
      assert.equal(calls, 1);
      console.log(JSON.stringify({operation:${JSON.stringify(operation)},calls,unhandled}));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    assert.deepEqual(JSON.parse(child.stdout), { operation, calls: 1, unhandled: 0 });
  });
}
