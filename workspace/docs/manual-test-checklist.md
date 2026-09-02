# Owner manual acceptance checklist

Use only the fresh artifact-built profile and loopback Web URL recorded in the
release report. Do not reuse a previous profile. The profile starts with no
provider credential and must produce zero provider egress until you act.

## Provider and routing

1. Open **Settings → Models**, add OpenRouter, and enter the key only in the
   masked UI field. Do not paste it into a terminal, issue, screenshot, or
   report.
2. Choose **Fetch available models**. Confirm the request is intentional and
   the returned list is visibly associated with OpenRouter.
3. Select one exact model, open **Role Bindings**, assign it to Chat, then run
   **Run provider test**. Saving the key alone must still read “not tested.”
4. Start a new session without selecting a model again. Send one short prompt.
   In OpenRouter usage, confirm exactly one Chat request reached the chosen
   model; account separately for any title-generation request and reject any
   unrecognized request.
5. Try an invalid key, insufficient balance/HTTP 402, HTTP 429, timeout, and
   **Cancel provider test**. Each must be named honestly, leave Chat closed or
   not tested, and expose a retry path. Restore the valid configuration only
   through the UI.

## Core, evidence, and browser authority

6. In **Diagnostics**, confirm the exact Watch Core version, stdio transport,
   contract match, and capability states. Stop and restart Core; the UI must
   move through loading/error and reconnect without a false Ready flash or a
   mock fallback.
7. Perform a harmless browser observation, then an approved local action.
   Deny once and confirm the page is untouched. Approve once, repeat the same
   idempotency key, and confirm the receipt is replayed rather than the action
   repeated.
8. Inspect the receipt and evidence record. `completed` may be true while
   `verified` is false when the postcondition does not hold. Only Watch Core
   may issue the deterministic `VERIFIED` verdict.

## Local product surfaces

9. In **Library**, add a fixture after startup, search before refresh, then
   choose **Refresh library**. It must appear without a restart. A failed
   refresh must retain the last good index and reveal no machine path.
10. In **Memory**, add a fact, correct it, forget it, and restart. The
    correction must win immediately; the forgotten item must be absent from
    retrieval, projection, and export; Local Personal must survive restart.
11. Open **Compare** and confirm output differences and verification
    differences remain separate; Compare itself must not mint a verdict.
12. Open **Watch** and **Live**. A capability row may say **Ready** only when
    Core reports it machine-tested here. A dependency that was found but never
    exercised reads **Not tested**, one that cannot run reads **Unavailable**,
    and one that runs impaired reads **Degraded** — each with a real remedy.
    Merely opening Live must request no permission.

## Web/Desktop parity and privacy

13. Open Desktop against the same fresh profile. Confirm Web and Desktop show
    the same provider binding, readiness, Library generation, and memory. Test
    native permission denial and clean shutdown with no orphan Host/Core.
14. Inspect the generated logs and reports without printing the credential.
    Confirm no key, authorization header, prompt/response body, user name,
    personal path, or raw provider error is present.
15. Remove the OpenRouter key through the UI and confirm Models, Role Bindings,
    Diagnostics, and Chat all return to unconfigured/not-tested without a real
    provider request.

External sign-off also records OpenRouter balance/request count, npm first
publication plus 2FA, per-package Trusted Publisher configuration, restricted
npm teams, Desktop signing/notarization, and any GPU-specific validation.
