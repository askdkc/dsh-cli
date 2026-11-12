# OpenCode failure compatibility

The provider-owned codes `MODEL_NOT_FOUND`, `UNSUPPORTED_CAPABILITY`,
`PROTOCOL_ERROR`, `PROVIDER_ERROR`, and `ATTACHMENT_UNAVAILABLE` remain stable.
They must not be renamed to builtin codes: a user's `retryableCodes` selects
these exact strings.

`OpenCodeFailure` is an `Error` with immutable, own data properties `code` and
`failure`. Their codes agree. Both the lockfile's DSH 0.2.1-alpha.1 and official
DSH e8f7b93a344964de3dca1ace9e72b6e4d6de87cb (0.2.2-rc.2) accept this shape at
the real LlmRuntime normalization boundary. No `LlmError.fromFailure()` call or
type assertion is needed. Runtime peer requirements are unchanged; the added
0.2.1-alpha.1 retry package is a test dependency only.

The constructor uses the common LlmError metadata validation, then carries the
original provider code. HTTP classification retains builtin AUTH, RATE_LIMIT,
SERVER and TRANSPORT. The HTTP boundary only copies validated status, positive
finite retry delay, and bounded request IDs. SDK messages, response bodies,
credentials and causes are not copied. Attachment read failure stops dispatch;
user cancellation remains cancellation.

Duplicate stream starts, mismatched deltas/ends, missing final tool calls,
unmatched tool calls and premature EOF cannot produce a successful finish.
Reader cancellation/release must still permit the next request.

## Regression coverage

The provider suite contains 101 tests (the existing 69 plus 32 failure/retry
checks), with no skipped tests:

- All eleven formerly incompatible call sites reach the real runtime with their
  original codes. The runtime's earlier reasoning validation still returns its
  builtin UNSUPPORTED_REASONING_EFFORT; the adapter's defensive check retains
  UNSUPPORTED_CAPABILITY.
- Invalid model/capability/attachment requests send no external call.
- HTTP 401/403, 429, 5xx, other HTTP and network errors retain their classification;
  numeric and HTTP-date Retry-After, request IDs and redaction are checked.
- A real runtime feeds the real retry plugin through an in-memory event/projection
  fixture: default policy does not retry a custom provider error, explicit
  PROVIDER_ERROR retries stop at maxRetries, and cancellation suppresses resend.
- SDK stream fixtures exercise abnormal transitions, idle timeout, user abort,
  reader release and a successful subsequent request.

`verify:upstream-source` rebuilds dsh-auth before running these tests against its
isolated source snapshot. Runtime and retry module resolution are asserted to
come from that snapshot, preventing installed-package fallback or stale output
from passing the source check.

## Reproduce

Run commands sequentially: package verification temporarily stages manifests and
bundled directories, so it must not overlap installs, builds or another pack.

```sh
pnpm compile
pnpm --dir dsh-auth verify
DSH_REQUIRE_UPSTREAM_BASELINE=1 pnpm verify:upstream-source --live-session
pnpm verify:opencode-profile --host-default
pnpm verify:opencode-profile
pnpm verify:build
pnpm test:compatibility
pnpm verify:package
pnpm verify:bun-package
```

The profile check installs the packed plugin into a disposable profile on the
distributed DSH version (the current alpha by default, or `DSH_AUTH_TEST_VERSION`).
The upgrade check uses a generated baseline
with a distinct version, so the release being tested does not select a package
from the npm release history. Its PTY check submits input, cancels an active
stream, submits another input and exits with `/quit`. It asserts exactly one
request for each generation; the host's separate session-title request is
identified separately. No live provider credential is used: a fetch fixture
supplies wire responses, while profile boot, UI, runtime and adapter are real.

The CI workflow is configured for pushes, pull requests, manual dispatch and a daily schedule. The
upstream job records the checked-out SHA, selects the corresponding distributed
DSH version, and records a success summary only after source/runtime and profile
checks pass. Local results do not establish Linux/Windows matrix or remote CI
success for an uncommitted diff.

Design review scope: code.boundary.v1 (metadata/privacy), code.protocol.v1
(stable codes, retry/cancellation), and code.verification.v1 (old/new runtime
and installed-profile evidence).
