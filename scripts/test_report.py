"""Authoritative test results, read from JUnit XML.

Progress dots are not a data format. They wrap, they carry percentage columns,
and counting them has twice produced wrong totals in this project's release
reports. Everything here comes from the XML pytest writes.

    python scripts/test_report.py results.xml [--skips] [--slow N] [--json]
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def load(path: Path) -> dict:
    root = ET.parse(path).getroot()
    cases, totals = [], collections.Counter()
    for case in root.iter("testcase"):
        name = f"{case.get('classname', '')}::{case.get('name', '')}"
        # `find(...) or find(...)` is wrong here: an ElementTree element with
        # no children is falsy, so that idiom silently discards every failure
        # that has a message but no sub-elements -- which is all of them. It
        # once reported a run with two failures as entirely green.
        skipped = case.find("skipped")
        failure = case.find("failure")
        if failure is None:
            failure = case.find("error")

        if skipped is not None:
            outcome, detail = "skipped", (skipped.get("message") or "").strip()
        elif failure is not None:
            outcome, detail = "failed", (failure.get("message") or "").strip()
        else:
            outcome, detail = "passed", ""
        totals[outcome] += 1
        cases.append({
            "name": name,
            "outcome": outcome,
            "detail": " ".join(detail.split())[:400],
            "seconds": float(case.get("time") or 0.0),
        })
    return {"cases": cases, "totals": dict(totals), "collected": len(cases)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("xml", type=Path)
    parser.add_argument("--skips", action="store_true")
    parser.add_argument("--failures", action="store_true")
    parser.add_argument("--slow", type=int, default=0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    data = load(args.xml)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    t = data["totals"]
    print(f"collected={data['collected']}  passed={t.get('passed', 0)}  "
          f"failed={t.get('failed', 0)}  skipped={t.get('skipped', 0)}")

    if args.failures or t.get("failed"):
        print("\n=== FAILURES ===")
        for case in data["cases"]:
            if case["outcome"] == "failed":
                print(f"  {case['name']}\n     {case['detail'][:300]}")

    if args.skips:
        grouped = collections.defaultdict(list)
        for case in data["cases"]:
            if case["outcome"] == "skipped":
                grouped[case["detail"][:110]].append(case["name"])
        print(f"\n=== {t.get('skipped', 0)} SKIPS "
              f"in {len(grouped)} distinct reasons ===")
        for reason, names in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
            print(f"\n[{len(names)}] {reason}")
            for name in names:
                print(f"    {name}")

    if args.slow:
        print(f"\n=== {args.slow} SLOWEST ===")
        for case in sorted(data["cases"], key=lambda c: -c["seconds"])[:args.slow]:
            print(f"  {case['seconds']:7.1f}s  {case['name']}")

    return 1 if t.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
