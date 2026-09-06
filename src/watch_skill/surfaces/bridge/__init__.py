"""The Bridge: Watch Core's stdio surface for a Host that embeds it.

DeepWatch runs Watch Core as a child process and talks to it over
``Content-Length``-framed JSON-RPC 2.0 on stdin/stdout. That contract lives
here, and *only* the contract lives here: every method in
:mod:`watch_skill.surfaces.bridge.methods` resolves to a function that already
exists elsewhere in Core, because a surface that reimplements the engine is a
second engine that will disagree with the first one.

The rules the transport layer keeps, all of which the Host depends on:

* stdout carries protocol frames and nothing else — one stray ``print`` breaks
  the stream for every request behind it;
* operational logging goes to stderr, where the Host reads it as diagnostics;
* no method returns a plausible-looking placeholder. A capability Core cannot
  actually perform answers ``bridge.capability_unavailable`` so the Host can
  disable it, which is a worse demo and a truthful one.
"""
from __future__ import annotations

from watch_skill.surfaces.bridge.protocol import (
    PROTOCOL_VERSION,
    PROTOCOL_VERSION_MIN,
)
from watch_skill.surfaces.bridge.server import serve

__all__ = ["PROTOCOL_VERSION", "PROTOCOL_VERSION_MIN", "serve"]
