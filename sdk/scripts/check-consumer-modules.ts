import { fileURLToPath } from 'node:url';
import { collectConsumerModuleReferences } from './consumer-module-references.ts';
import { consumerModulePolicy } from './consumer-module-policy.ts';

// Read syntax only, before any verifier or helper can execute. A clean checkout
// may not have dist yet; compiled-module existence is checked after the CI build.
const policy = consumerModulePolicy(fileURLToPath(new URL('../../', import.meta.url)));
const result = collectConsumerModuleReferences(policy);
console.log(
  JSON.stringify({
    consumerRolesVerified: true,
    helpers: result.helpers.length,
    compiledModuleExistenceChecked: false,
    consumerExecuted: false,
  }),
);
