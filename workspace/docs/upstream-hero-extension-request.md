# Upstream hero identity extension request

Status: open upstream limitation in DeepSeek Harness `0.1.1-rc.2`.

The empty conversation hero owns the locale key `ui-conversation:hero.headline`
(“Into the Unknown”) and its bare “Preview” badge. DSH exposes only
`conversation.hero.brand.mark`, a 34-pixel mark slot. `LocaleService.register`
does not permit another plugin to replace a key in the owning namespace, and
there is no supported headline/badge slot or locale override API.

DeepWatch therefore occupies the supported mark slot and adds its own
“DeepWatch · See what happened. Prove what changed.” line wherever the session
dock exists. It does not patch or fork DSH. On the cold empty state the
upstream headline remains; DeepWatch branding elsewhere—tab, sidebar, About,
Desktop title/icon, and attribution—stays unambiguous. Visual identity is not
called fully closed while this headline remains.

## Requested upstream seam

Provide either:

- `conversation.hero.headline` and `conversation.hero.badge` client slots whose
occupants receive the upstream defaults as fallbacks; or
- an owner-authorized `LocaleService.override(namespace, locale, values)` API
  scoped to a composed distribution.

The seam must preserve stock defaults when unoccupied, accept exactly one
owner after composition, participate in loader conflict diagnostics, and be
covered by the upstream Web accessibility tests. With it, DeepWatch will render
“Into the Know” / “DeepWatch Preview” without changing any upstream source
file. The wording deliberately turns the upstream uncertainty into the product's
evidence promise; until the seam exists, it appears only on DeepWatch-owned
surfaces and never masquerades as an upstream override.
