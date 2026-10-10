# Lifecycle and error contracts

- One worker owns one account data directory. Locks prevent concurrent owners.
- Every pending IPC request settles once; timeout, reply, send failure, offline,
  exit and close all retire their corresponding map entries and timers.
- The channel captures the sending transport per request. The three reviewed HTTP
  reads use best-effort per-request cancellation on timeout, send failure and
  offline; it never targets a replacement worker. `WorkerReadRequests` owns their
  controllers, detaches before abort and observes late native completions. Its
  signal reaches the Session adapter, HTTP IO and next-page guard. Cancellation
  affects no sibling read, does not close the account, and cannot undo a native
  invocation or remote mutation. Delivery failure preserves the original error.
- Login timeout retires the worker generation before a replacement is allowed.
- Capture and validate a complete public operation before an asynchronous lookup
  or native mutation. Recheck session lifetime after asynchronous work.
- Native callbacks without a request nonce use coalescing or invalidation where
  required. A failed channel cannot safely accept a retry's late callback.
- Native composition is transactional: a failure stops callbacks and unwinds
  successfully acquired modules. Normal close is idempotent and attempts every
  cleanup. A single teardown error retains its identity/code; multiple failures
  retain their original values in an `AggregateError`. Cleanup never retries a
  native operation.
- Account state, generation, timers and pending settlement converge before
  fallible teardown. Offline/logout events still report the original transition.
  Cleanup diagnostics expose typed message/name/code records rather than native
  Error instances or arbitrary error properties.
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
