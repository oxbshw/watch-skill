# Announcement drafts

Drafts for the Watch Skill 1.4.2 / DeepWatch 0.1.3 release. **Nothing here has
been posted.** They are kept in the repository so the claims in them can be
checked against the same evidence everything else is checked against, before
anybody publishes one.

Rules these follow, and that a rewrite should keep:

- No endorsements, no adoption figures, no benchmark improvements. This project
  has none it has measured, and inventing them is the fastest way to lose the
  only thing it is selling.
- Every capability named is one a journey in this release actually exercised.
- Version numbers are stated once, at the top, so a stale draft is obvious.

---

## The release, in one paragraph

Watch Skill 1.4.2 and DeepWatch 0.1.3. 1.4.2 fixes `watch_moment`, which never
once returned an answer: the Host forwarded a parameter under the wrong name, so
every call was refused for its shape, and behind that refusal the Bridge tried
to iterate a dataclass instead of serialising it. Two defects, stacked, and the
first hid the second. 0.1.3 requires the fixed engine and carries a corrected
installation path for people adding the bundle to a Harness they already run.

---

## GitHub Release notes

> ### Watch Skill 1.4.2
>
> **`watch_moment` now returns a moment.** It never had. The Host sent
> `atMs` to a Bridge method that reads `timestampMs`, so every call was refused
> for its shape — and behind that refusal the handler serialised its result with
> `context.to_dict() if hasattr(...) else dict(context)` against a dataclass
> that has no `to_dict`, so the fallback ran and a dataclass is not iterable.
> Nothing caught either one, because no test had ever asked the method for an
> answer. There are twelve now, and two of them require the moment rather than
> accepting a refusal.
>
> Upgrade with `pip install -U 'watch-skill[standard,ocr]'`.
>
> ### DeepWatch 0.1.3
>
> **Requires Watch Skill 1.4.2.** On any earlier engine `watch_moment` raises
> rather than answering.
>
> **The installation instructions for an existing Harness were wrong.**
> `dsh web` is an alias of `dsh --profile web`, so `dsh --profile <name> web`
> booted your profile and handed `web` to the app as an argument. It is
> `dsh --profile <name>`, run from the directory you are working in — the
> receipt journal is written under the launch directory, and a Host started
> elsewhere journals elsewhere.
>
> **The release smoke now waits for the whole dependency closure.** It measured
> one package and then asked `npx` to resolve sixteen, which is why 0.1.2's
> published-install check went red on Linux and macOS while the packages were
> fine. It now walks the closure, keeps its own cache, and — this is the point —
> still fails on an `ETARGET` for a version the registry does not hold, because
> that is a wrong dependency range and not a slow replica.

---

## Short post (280 characters)

> Watch Skill 1.4.2 is out. `watch_moment` now returns a moment — it never had:
> one parameter sent under the wrong name, and a serialisation bug hiding behind
> the refusal it caused. Twelve new tests, two of which demand an answer rather
> than accepting a refusal.

## Short post, DeepWatch

> DeepWatch 0.1.3. Needs Watch Skill 1.4.2, and fixes the install instructions
> for adding it to a Harness you already run: `dsh web` is an alias of
> `dsh --profile web`, so `dsh --profile <name> web` was booting your profile and
> passing `web` to the app.

---

## Longer post

> Two defects shipped in Watch Skill 1.4.1, stacked so that the first hid the
> second.
>
> `watch_moment` asks the engine what was on screen at an instant. The Host sent
> its own parameter name — `atMs` — to a Bridge method that reads `timestampMs`,
> so every call was refused a step early with a clean, correct
> `bridge.invalid_params`. Behind that refusal, the handler serialised its result
> with `context.to_dict() if hasattr(context, 'to_dict') else dict(context)`.
> `MomentContext` is a dataclass and has never had a `to_dict`, so the fallback
> ran, a dataclass is not iterable, and the call raised. Nothing ever reached it
> to find out.
>
> The test that existed accepted `bridge.invalid_params` as proof the method was
> there. It was — and it could not answer.
>
> 1.4.2 fixes both. The new tests require a payload, the frames in it, the
> timestamp asked for and the default window, and keep the old parameter name
> refused so the two halves cannot drift apart again in the other direction.
>
> A real model then found a checkout bug from a screen recording, called
> `watch_moment` twice while it worked, repaired the code, and had the repair
> checked by a contract frozen before it started and evaluated in a separate
> process. That is the whole point of the tool, and until this release one of
> the steps in it did not run.

---

## What not to say

- Do not call the `--artifacts` install air-gapped. It takes the DeepWatch
  packages from local tarballs; the pinned Harness and its peer closure still
  come from npm, and `setup` prints that before it fetches anything.
- Do not say denied writes are "refused rather than logged". They are refused
  **and** journalled, with `scope:outside_workspace` / `state:cancelled`.
- Do not describe a verification against the wrong directory as "it fails"
  without saying which verdict. Checks that run and report false give `FAILED`;
  checks that cannot run give `INCONCLUSIVE`; an expectation with no executable
  check gives `UNVERIFIED`.
- Do not mention the Desktop app. It is not distributed: there is no installer
  and no packaging job.
