# Lifecycle and error contracts

- One worker owns one account data directory. Locks prevent concurrent owners.
- Every pending IPC request settles once; timeout, reply, send failure, offline,
  exit and close all retire their corresponding map entries and timers.
  Batch retirement detaches all selected entries before calling cancellation
  transports, so a reentrant sibling reply cannot turn retirement into success.
- Offline notifications retire the old account, restore policy and pending RPCs
  before synchronous state observers run. Close RPCs retain their acknowledgement
  path. Observer throws and injected late replies cannot undo that retirement;
  observer-started login is new work. Logout and kick remove the previous default
  account before observers can reconnect. The latest nested offline notification
  controls automatic restore, which never overrides a new login or account.
  Retry-policy inspection failure still retires the account and pending RPCs;
  its original value is preserved, alongside any notification failure. Reentrant
  close or a newer offline notification suppresses the obsolete event.
- The channel captures the sending transport per request. The three reviewed HTTP
  reads use best-effort per-request cancellation on timeout, send failure and
  offline; it never targets a replacement worker. `WorkerReadRequests` owns their
  controllers, detaches before abort and observes late native completions. Its
  signal reaches the Session adapter, HTTP IO and next-page guard. Cancellation
  affects no sibling read, does not close the account, and cannot undo a native
  invocation or remote mutation. Delivery failure preserves the original error.
- Login timeout commits failed state, removes the account and retires pending
  requests before synchronous state notification. It cancels scheduled automatic
  restore and binds shutdown to the timed-out worker. Notification failure cannot
  skip shutdown or its exit gate. Timeout and notification errors retain their
  original values in an `AggregateError`; a shutdown failure is also retained.
  Close and explicit reconnect join that worker's reserved termination Promise,
  including a terminal failure, without repeating signals or cleanup deadlines.
  A replacement starts only after the previous worker has exited successfully.
- Replacement initialization and login failures use the same retirement
  transaction as a login deadline. They reject sibling requests before notifying
  `failed`, then wait for the captured replacement's exit. An ordinary operation
  failure retains its identity; notification and cleanup failures are retained
  alongside it. A replacement login timeout joins its existing retirement result
  when it reaches reconnect's catch, without another notification or aggregation.
- Reconnect reserves its shared Promise before the synchronous `connecting`
  notification, and schedules replacement only after notification succeeds.
  A notification failure rejects that Promise with the original value and leaves
  the old worker, account and pending requests intact. It restores the previous
  internal state only while the same transition still owns it; nested close,
  offline, readiness or login work takes precedence. Reentrant same-request calls
  join the reserved result; another request rejects, and explicit recovery is
  available after the failed attempt is released.
- Previous-worker retirement and replacement creation errors retain their
  original value. If their `failed` notification also throws, reconnect rejects
  with an `AggregateError` containing the operation and notification failures.
  It does not retry termination or clean up an unallocated replacement. A failed
  previous-worker termination remains a failure, without claiming process exit.
- Parent close reserves its shared Promise before synchronous `closing` events.
  An observer failure cannot skip shutdown or the worker-exit gate. Successful
  cleanup reaches `closed` before close rejects with the original observer value;
  simultaneous cleanup failure retains both values in an `AggregateError`.
  If notifying `failed` also throws, the cleanup and notification failures retain
  their original identities. A preceding `closing` observer failure remains first,
  followed by cleanup and failed-state notification. Normal close and close during
  worker retirement share this rule without repeating termination. Failed
  termination does not prove process exit; cleanup retains its existing precedence
  over an unacknowledged shutdown request's error.
- Authentication captures each selected service and native callable once,
  preserving its receiver. Reentrant retirement during acquisition stops dispatch;
  active acquisition errors retain their identity without a fallback or retry.
- Capture and validate a complete public operation before an asynchronous lookup
  or native mutation. Recheck session lifetime after asynchronous work.
- Native callbacks without a request nonce use coalescing or invalidation where
  required. A failed channel cannot safely accept a retry's late callback.
- Native composition is transactional: a failure stops callbacks and unwinds
  successfully acquired modules. Normal close is idempotent and attempts every
  cleanup. A single teardown error retains its identity/code; multiple failures
  retain their original values in an `AggregateError`. Cleanup never retries a
  native operation. Operation/cleanup aggregation expands ordinary own-data
  error lists; a throw that cannot be inspected safely stays as its original value.
  Error accessors cannot replace the primary failure.
- Account state, generation, timers and pending settlement converge before
  fallible teardown. Offline/logout events still report the original transition.
  Cleanup diagnostics expose typed message/name/code records rather than native
  Error instances or arbitrary error properties.
- IPC messages, native connection callbacks, authentication polling and account startup dispatch
  their background Promises through `runtime/worker-task`. Expected failures stay
  with the authentication/account owner. An escaping rejection, such as a failure
  observer throwing, schedules a fatal exception after current Promise settlements;
  it does not notify that observer again or replay native work. Node's default
  uncaught-exception handling exits the isolated worker even when unhandled-rejection
  mode is `warn`. The parent retires account state and pending requests on exit,
  and worker exit releases its locks. An already settled login result is unchanged;
  delivery of that result over IPC before exit is not guaranteed. This terminal
  path does not await asynchronous Session cleanup. Applications must not install
  an exception handler in the worker that allows it to continue after fatal errors.
  Default Node stderr is an internal crash diagnostic, not a sanitized public DTO.
- The worker computes a business result or error before attempting its one reply.
  A sending exception is a transport failure: it does not become a business error
  reply or cause another send attempt. Failed result/error delivery and failed close
  acknowledgements use the same fatal worker task policy. Successful close retains
  cancellation, awaited bootstrap cleanup, acknowledgement and exit in that order.
  The synchronous message listener starts its owned asynchronous task immediately,
  so cancellation controls keep their existing ordering and requests remain concurrent.
- Error serialization includes only explicitly supported data fields. It never
  coerces an unknown object or invokes error accessors; invalid fields, trapping
  proxies and inaccessible progress records cannot prevent an RPC failure reply.
  Normal Error messages, names, finite numeric/string codes and validated merged
  progress retain their contracts. Callback failure paths share this projection
  and preserve ordinary Error identity. Error events retain their message-only
  payload. Native objects, tickets, arbitrary causes and stacks are not part of
  the IPC error DTO.
- Tests using controlled services prove SDK behavior, not real native/account
  interoperability. Account acceptance and platform CI evidence remain separate.

[Architecture overview](../architecture.md) · [Development guide](../development.md)
