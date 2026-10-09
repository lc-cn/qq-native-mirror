import test from 'node:test';
import {createNativeServices} from '../src/native-services.ts';
import {checkForwardResourceServices,checkForwardResourceTypedElements} from '../scripts/forward-resource-consumer-contract.mjs';
test('resource read dispatches one observed SSO request with exact authenticated UID and no synthetic/native identities',async()=>{
 await checkForwardResourceServices({createNativeServices});
});
test('resource service keeps typed mentions, extended faces and opaque legacy data without UID lookup or replay',async()=>{
 await checkForwardResourceTypedElements({createNativeServices});
});
