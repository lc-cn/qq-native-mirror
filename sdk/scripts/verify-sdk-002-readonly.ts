import { runReadonlySdkAcceptance } from './readonly-sdk-acceptance.ts';

// Fixed historical scope; --execute-approved is not human authorization.
const result = await runReadonlySdkAcceptance(
  {
    root: '.local/acceptance/sdk-002-readonly-v1',
    release: '.local/releases/npm-0.0.2-ci-37925080425',
    planSha256: '73caa95d6bfe4c7fd56e57cf87893ea220af0d2526b9c0c9aa28c50f23b23d1b',
    sourceCommit: 'b4b2e4eab5e44f99126e2efc68d6701ac7658833',
    sourceRunId: '37925080425',
  },
  process.argv.slice(2),
);
if (result.mode === 'review') console.log(JSON.stringify(result.review, null, 2));
else process.exitCode = result.exitCode;
