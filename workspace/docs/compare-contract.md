# The Compare contract

What comparing two runs says, and what it refuses to say.

## Compare observes, it never decides

Two runs disagreeing is a fact about the two runs. Which one is right is a
verdict, and only Watch Core mints verdicts
([ADR-002](adr/ADR-002-truth-ownership.md)). Compare may report that a verdict
changed; it never decides which side was correct, and it produces no verdict of
its own.

The comparison is a pure function. No `Math.random`, no `Date.now`, no network:
two calls over the same pair produce byte-identical output, which is what makes
a difference report evidence rather than an impression.

## Claims and output are separate

A run has claims -- things asserted, each with a verification state -- and
output, the free-form text the agent produced. They are rendered in different
sections and never merged.

Merging them would let a reworded sentence read as a changed verdict, and a
changed verdict hide inside a paragraph diff.

## The six dispositions

| Disposition | When | Example |
| --- | --- | --- |
| `matching` | same text, same verdict, and the verdict says something | VERIFIED both sides, identical claim |
| `changed` | present on both, the text differs | "the file was uploaded" becomes "…to the bucket" |
| `verdict_changed` | same text, the verification moved | VERIFIED to INCONCLUSIVE |
| `contradictory` | the verdicts cannot both hold | VERIFIED to FAILED |
| `unverifiable` | identical on both sides, and neither was checked | UNVERIFIED both sides |
| `missing_right` / `missing_left` | present on one side only | a claim one run never made |

Two of these deserve explanation, because the weaker word would have been
easier and wrong.

VERIFIED against FAILED is `contradictory`, not `verdict_changed`. The two runs
are not disagreeing about a rating; they assert opposite things about the same
claim, and exactly one of them is wrong about the world.

UNVERIFIED against UNVERIFIED is `unverifiable`, not `matching`. Nothing was
checked on either side, so there is nothing to compare. Calling two absences an
agreement is the collapse between "nobody looked" and "it's fine" that this
product exists to prevent.

Each disposition carries a `because` in words a person can check, rather than
only a label.

## When two records cannot be compared

`isComparable` gates it, and a refusal is reported with a reason:
`left_missing`, `right_missing`, or an incompatibility that
`describeIncompatibility` puts into words. Compare never fabricates a second
column to have something to diff against.

## Output differences

Reported separately: whether the outputs are identical, and the first line where
they diverge. Text, not markup. Nothing in the shipped tree writes HTML from a
value, and a test holds that over the whole tree.

## Verified end to end

Against the cold build, all six dispositions were reached by cases constructed
to produce each one, and two calls over the same pair produced byte-identical
results. One run of them is recorded in
[history/validation-matrix-71300c0.md](history/validation-matrix-71300c0.md);
the current numbers come from the exact-head CI jobs.
