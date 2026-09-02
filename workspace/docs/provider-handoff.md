# Connecting a real provider

For the manual session where a real provider is connected for the first time.
Everything below was walked through against the running application with a
local stub standing in for the provider, so the paths and field names are the
ones you will see. No real provider has been contacted.

## Before you start

Start a fresh artifact-built Web profile as described in
[setup.md](setup.md), then use the loopback URL printed by that process. For a
Desktop smoke, run the locally installed Electron binary from
`apps/desktop`; no previous process is assumed to exist.

The workspace runs without a provider. Perception, memory, verification and the
browser all work offline, and Diagnostics lists which capabilities are ready and
which are not configured. A provider adds the agent model, and Role Bindings
lets you bind it to other roles if you want to.

## Adding the provider

Settings is at the bottom of the sidebar. Provider configuration lives in DSH's
own **Models** section, above the Watch sections. Watch does not duplicate it.

For a hosted provider, use **Add provider** and pick the route. The catalogue
has 37 routes; DeepSeek is one of them and is not required.

For a local model or any OpenAI-compatible endpoint, use **Add a custom
provider**. The fields are:

| Field | Notes |
| --- | --- |
| Provider ID | lowercase, starts with a letter; also the credential name |
| Display name | what appears in the model picker |
| Base URL | for a local server, e.g. `http://127.0.0.1:11434/v1` |
| API protocol | `openai-completions`, `openai-responses`, or `anthropic-messages` |
| API key | masked input, `autocomplete` off |

A local server such as Ollama, vLLM, LM Studio or llama.cpp is a base URL you
supply with `openai-completions`, not a separate feature.

## Testing the connection

**Fetch available models** in the provider dialog interrogates the configured
endpoint and lets you adopt returned models. It proves discovery only. After
assigning an exact provider/model in **Role Bindings**, choose **Run provider
test**. That one bounded model request is the fact that changes the binding
from “Configured · not tested” to Ready; saving a credential never does.

If it returns nothing, the dialog says so and notes that unlisted model IDs can
still be sent directly.

Failure modes worth trying deliberately, since they are the ones that look
alike from the outside:

| What to do | What you should see |
| --- | --- |
| Wrong base URL | a transport error naming the URL, not a hang |
| Wrong key | an authentication failure, not a generic error |
| Endpoint that is up but rate limits | the provider's own message, and a retry hint if it sent one |
| Endpoint stopped mid-session | a timeout, then the Bridge's own retry state in Diagnostics |

## Where the secret goes

A key entered through the Models page is written to
`$DSH_HOME/.credentials.yaml`, a file DSH owns that holds nothing but
credentials and is never materialised into the environment. An inherited
environment variable wins over it and is visibly read-only, so a key exported in
your shell cannot be silently shadowed by one stored in the UI.

On Desktop, Watch's own vault uses Electron `safeStorage`, which is OS-backed.

The key is not written to `settings.yaml`, which holds UI state only.

Provider consent and evidence/media egress are separate boundaries. Saving a
provider credential or testing a one-token role request authorizes neither a
video upload nor evidence transmission. Watch Core remains local-only by
default; cloud perception requires its own user-controlled opt-in and policy
check before a key is read or a request is built. The agent cannot flip either
setting.

Confirm that yourself after entering one — without printing either file. A
credential file is not a thing to display: a terminal keeps scrollback, a
screen share carries it, and the answer you actually want is *which store holds
it*, not what the value is.

```bash
# The credential store exists and only you can read it. No contents.
ls -l "$DSH_HOME/.credentials.yaml"
```

```bash
# settings.yaml holds UI state, and the key is not among its fields.
grep -c 'apiKey\|api_key' "$DSH_HOME/settings.yaml"   # expect 0
```

In the product itself, **Settings, Models** shows the provider with a stored
credential and where it came from — the credential store or an inherited
environment variable. That reading comes from the credentials service, which is
the authority; the file listing above only confirms the store is where you
expect it to be.

## Binding the provider to a role

Settings, **Role Bindings**. Nine roles; the agent model is the only one a chat
provider fills by default. Each row shows implementation, provider or engine,
status, and when it was last tested. Before you bind anything they all read
"Nothing bound on this machine" and "Last tested: Never".

Binding a role to a provider is what makes that capability use it. A role with
nothing bound is shown as unbound and never falls back to the agent model
silently.

## The first real session

1. New Session, then choose or add a workspace.
2. Pick the model in the composer's model selector.
3. Send a message.

The session header with the seven mode tabs appears once a turn has happened.
Before that DSH hides it, and the tabs are genuinely absent rather than hidden
by Watch.

## What to verify, in order

**Chat and Trajectory** are DSH's own, and the point is that they are unchanged:
streaming, retries, steering, the queue, branches, compaction, tools,
permissions, approvals, subagents and attachments should all behave as they do
in stock DSH.

**Watch** should show a verification record when you select a Watch tool row in
Chat. A verdict of UNVERIFIED is a normal outcome and must not be rendered as
success. Green is reserved for VERIFIED.

**Live**: open it and confirm nothing is requested. Then start a source and
confirm the permission prompt appears at that moment. Browser Observer and
Browser Operator are separate; only the operator can act, and its side effects
carry an idempotency key.

**Memory**: add something, correct it, forget it, and confirm the correction
takes precedence and the forget actually removes rather than hides.

**Library**: run a search. The index is local. Check the health line and the
Rebuild index button.

**Compare**: run the same task twice and compare the two runs. Verification
differences and output differences are separate sections. A verdict that moved
from VERIFIED to FAILED reads as contradictory, not as a changed rating.

## Evidence to look for

After a verification runs, the record should appear in Watch, and the same
record should be findable in Library by searching a word from its text. Those
two surfaces read the same records; if one has it and the other does not, that
is worth reporting.

## If something fails

Collect:

- Settings, Diagnostics, which lists capability readiness and reads values from
  the running system rather than showing defaults
- the Desktop logs, if Desktop was involved
- the browser console for the Web app
- what you did, what you expected, and what appeared instead

The distinction that matters in a report: whether the agent said it worked, and
whether verification agreed. Those are different observations and this product
exists to keep them apart.

## Removing the credential afterwards

Settings, Models, **Edit** on the provider, and remove the key.

To confirm it is gone, read the state rather than the file. **Settings,
Models** shows the provider with no stored credential, and Diagnostics reports
the role as unconfigured. If you want a check outside the UI, ask the provider
rather than the disk:

Use **Run provider test** on the affected Role Bindings row. With the key
removed it reports the missing credential without displaying a value. There
is no `deepwatch providers test` command in this candidate.

If you exported a key into your shell instead, unset it and restart the host;
the environment layer takes precedence and will otherwise keep the provider
configured.
