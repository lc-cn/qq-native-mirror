import { runReadonlySdkAcceptance } from './readonly-sdk-acceptance.ts';

// Fixed historical scope; --execute-approved is not human authorization.
const result = await runReadonlySdkAcceptance(
  {
    root: '.local/acceptance/sdk-002-readonly-v2',
    release: '.local/releases/npm-0.0.2-ci-37962268125',
    planSha256: 'b48706e1350a03775069d2d4c1b2d6bf662f4fcd0a75fbb8ffba00957074b6a7',
    sourceCommit: '6cae1ec0a5e1bfb03cb7871083915b3d03272347',
    sourceRunId: '37962268125',
  },
  process.argv.slice(2),
);
if (result.mode === 'review') console.log(JSON.stringify(result.review, null, 2));
else process.exitCode = result.exitCode;
