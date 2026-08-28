# ADR-009: the Library index is local, derived, and rebuildable

**Status:** accepted
**Date:** 2026-08-28
**Supersedes:** nothing
**Related:** [ADR-002](ADR-002-truth-ownership.md), [ADR-004](ADR-004-bridge-contract.md)

## Context

Library had a search box that could not answer, because there was nothing on
the client to search. The obvious fix — ask Watch Core — turned out not to be
available.

A `conversation.view` entry receives `{ inspect, onInspectDone }` and nothing
else. `ctx.remote` is an event bus (`$on`, `$dispatch`, `$mount`), not a query
client, and there is no client-reachable Watch query route. A view can render
the record a person selected; it cannot ask a question about records it has not
been handed.

So the choice was between adding a client-reachable query route to Watch Core —
a Core change, for a feature that is not about truth — or building the index
where the records already are.

## Decision

The index lives on the **host**, as a Watch tool (`watch_library_search`), and
in the **client** as a store the view owns (`LibraryIndex`). It is:

- **local** — an inverted index over records this workspace already has. It
  reaches no network and needs no provider. Retrieval falls back to lexical
  matching when no embedding model is bound, and says so.
- **derived** — it holds nothing that is not reconstructible from the records.
  Losing it costs time, never data.
- **versioned** — `INDEX_VERSION`, checked on load. An index written by a newer
  build is refused rather than misread.
- **rebuildable** — `markStale`, `clear` and a Rebuild control in the view. A
  corrupt index is an inconvenience, not a dead end.
- **self-reporting** — `empty`, `ready`, `indexing`, `stale`, `corrupt`. A
  search returning nothing from a broken index would otherwise be
  indistinguishable from one that correctly found nothing.

## Consequences

**Watch Core is unchanged.** No Core contract was added for this, which was the
point: the smallest change that works is the one that does not touch the engine
that mints verdicts.

**The index asserts nothing about truth.** It returns records and where the
match was. Verdicts on those records came from Watch Core and are carried
through untouched — ADR-002 is not weakened, because nothing here mints
anything.

**Two implementations, one contract.** The host tool and the client store both
build on `index-store.ts`, reached through a plain-ESM subpath. They cannot
drift apart in their tokenizing or their ranking, which is the part a user
would notice.

**The tokenizer is deliberately multilingual.** Latin-script words keep their
combining marks — Arabic harakat are `\p{M}`, not `\p{L}`, and treating them as
separators split every vowelled word into fragments. CJK runs are indexed as
characters and bigrams rather than as one unmatchable run, because no user types
the whole run.

**It is not a semantic index.** Without an embedding model it matches lexically,
and the Diagnostics page says so rather than implying otherwise.

## Alternatives rejected

**Add a query route to Watch Core.** Rejected: it is a Core change for a
non-truth feature, and it would put search latency on the Bridge.

**Search the DOM.** Rejected: it can only find what is already rendered, which
is the subset a person is looking at — the opposite of what search is for.

**Ship no search until Core offers a route.** Rejected: the shipped state was a
search box that could not answer, which teaches people the product is broken
rather than that a capability is absent.
