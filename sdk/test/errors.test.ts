import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeKernelError,deserializeKernelError,KernelRequestError} from '../src/errors.ts';
test('kernel error serialization preserves codes without serializing arbitrary payloads',()=>{
 const original=Object.assign(new Error('native operation failed'),{code:23,secret:'fixture secret',cause:{token:'fixture token'}});
 const serialized=serializeKernelError(original);
 assert.deepEqual(serialized,{message:'native operation failed',name:'Error',code:23});
 const restored=deserializeKernelError('setGroupName',serialized);
 assert.ok(restored instanceof KernelRequestError);assert.equal(restored.operation,'setGroupName');assert.equal(restored.code,23);
 assert.equal(restored.message,original.message);assert.equal(restored.originalName,'Error');
 assert.ok(!JSON.stringify(serialized).includes('fixture'));
});
test('legacy string failures and malformed error codes retain deterministic worker errors',()=>{
 assert.equal(deserializeKernelError('init','old error').message,'old error');
 assert.equal(deserializeKernelError('init',{message:'bad',code:{secret:'never copy'}}).code,undefined);
 assert.equal(deserializeKernelError('init',null).message,'Kernel request failed');
 assert.deepEqual(serializeKernelError(Object.assign(new Error('missing file'),{code:'ENOENT'})),{message:'missing file',name:'Error',code:'ENOENT'});
});
