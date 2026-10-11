import { runReadonlySdkAcceptance } from './readonly-sdk-acceptance.ts';

// Fixed historical scope; --execute-approved is not human authorization.
const result = await runReadonlySdkAcceptance(
  {
    root: '.local/acceptance/sdk-002-readonly-v3',
    release: '.local/acceptance/sdk-002-readonly-v3/artifacts',
    planSha256: '64d0a3b1aa5e71911d152def500585075e5168aaf96c6c24bbc442bb8ed7060c',
    sourceCommit: '5907793ad848c68b3183ac5c2f2b06fbd1a5e0cf',
    sourceRunId: '38000680198',
    nativeSource: { commit: '6cae1ec0a5e1bfb03cb7871083915b3d03272347', runId: '37962268125' },
  },
  process.argv.slice(2),
);
if (result.mode === 'review') console.log(JSON.stringify(result.review, null, 2));
else process.exitCode = result.exitCode;
