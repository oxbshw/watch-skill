/**
 * Fold the Next.js static export into one self-contained document.
 *
 * The MCP Apps resource carries the workspace as inline text, and the CSP it
 * declares has no remote origins and no `'self'` to fetch from — a host hands
 * the app to a sandbox as a string, not as a directory it can serve. So a
 * multi-file export, which is what `next build` correctly produces, has to
 * become a single file before it can ship.
 *
 * What this does, in order:
 *   1. read `out/index.html`
 *   2. replace every `<script src="/_next/...">` with the script's contents
 *   3. replace every `<link rel="stylesheet">` with a `<style>` block
 *   4. drop preload/prefetch hints, which point at files that no longer exist
 *      and would otherwise be requests the CSP refuses
 *   5. write the result to the Python package's static directory
 *
 * Both artefacts are kept. The directory export is what the "static asset"
 * gate checks and what a plain web host could serve; the single file is what
 * the MCP resource carries. They are built from the same compilation, so they
 * cannot disagree about what the workspace does.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const OUT_DIR = join(APP_ROOT, "out");
const TARGET = resolve(
  APP_ROOT,
  "..",
  "src",
  "watch_skill",
  "surfaces",
  "mcp",
  "static",
  "workspace.html",
);

/** Resolve an exported asset URL to a path inside the export directory. */
function assetPath(url) {
  const clean = url.split("?")[0].split("#")[0];
  const relative = clean.startsWith("/") ? clean.slice(1) : clean;
  return join(OUT_DIR, relative);
}

/** Escape a string for use inside a regular expression. */
function reEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a stylesheet from Next's flight payload once it has been inlined.
 *
 * These references are *not* inert, which is the trap. The App Router reads
 * them out of `self.__next_f` at runtime: React 19 hoists any `link` element
 * carrying a `precedence` into the head, and the `HL` row is an explicit
 * preload directive. Left in place, both fetch a file that no longer exists —
 * a 404 against the dev host, and against an MCP host with no server and
 * `connect-src 'none'`, a blocked request instead.
 *
 * Two forms, both escaped once because they live inside a JS string literal:
 *
 *   `N:HL[\"/_next/static/css/x.css\",\"style\"]\n`   preload directive
 *   `[\"$\",\"link\",\"0\",{\"rel\":\"stylesheet\",…}]`  hoisted element
 *
 * The element is replaced with `null` rather than deleted, so the surrounding
 * children array keeps its shape; React ignores a null child.
 */
function stripFlightStylesheet(html, cssUrl) {
  const escaped = reEscape(cssUrl);
  let out = html;

  out = out.replace(
    new RegExp(`[0-9a-f]*:HL\\[\\\\"${escaped}\\\\",\\\\"style\\\\"\\]\\\\n`, "g"),
    "",
  );

  // The object has no nested braces — rel/href/precedence/crossOrigin/nonce
  // are all scalars — so `[^}]*` terminates correctly.
  out = out.replace(
    new RegExp(
      `\\[\\\\"\\$\\\\",\\\\"link\\\\",\\\\"[^"\\\\]*\\\\",` +
        `\\{\\\\"rel\\\\":\\\\"stylesheet\\\\",\\\\"href\\\\":\\\\"${escaped}\\\\"[^}]*\\}\\]`,
      "g",
    ),
    "null",
  );

  return out;
}

function escapeForScript(code) {
  // A closing tag inside script text ends the element early. This is the one
  // escaping bug that turns a working bundle into a blank page, and it only
  // shows up once some dependency happens to contain the sequence.
  return code
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<!--/g, "<\\!--");
}

function main() {
  const indexPath = join(OUT_DIR, "index.html");
  if (!existsSync(indexPath)) {
    console.error(
      `no export found at ${indexPath} — run \`next build\` first`,
    );
    process.exit(1);
  }

  let html = readFileSync(indexPath, "utf8");
  let inlinedScripts = 0;
  let inlinedStyles = 0;
  const stylesheetUrls = [];

  // Stylesheets first: they are referenced from <head> and inlining them
  // before the scripts keeps the document order the browser expects.
  html = html.replace(
    /<link[^>]*rel=["']stylesheet["'][^>]*>/gi,
    (tag) => {
      const match = tag.match(/href=["']([^"']+)["']/i);
      if (!match) return tag;
      const path = assetPath(match[1]);
      if (!existsSync(path)) return tag;
      inlinedStyles += 1;
      stylesheetUrls.push(match[1].split("?")[0]);
      return `<style>${readFileSync(path, "utf8")}</style>`;
    },
  );

  // Preload and prefetch hints name files that will not exist in the single
  // document. Left in place they are requests against a CSP with no origins.
  html = html.replace(
    /<link[^>]*rel=["'](?:preload|prefetch|modulepreload|dns-prefetch|preconnect)["'][^>]*>/gi,
    "",
  );

  html = html.replace(
    /<script([^>]*)\ssrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (tag, before, src, after) => {
      const path = assetPath(src);
      if (!existsSync(path)) return "";
      inlinedScripts += 1;
      const isModule = /type=["']module["']/i.test(before + after);
      const code = escapeForScript(readFileSync(path, "utf8"));
      return `<script${isModule ? ' type="module"' : ""}>${code}</script>`;
    },
  );

  // `crossorigin` on an inline script is meaningless and, on some hosts,
  // enough to make the sandbox refuse it.
  html = html.replace(/\s+crossorigin(=["'][^"']*["'])?/gi, "");

  // Now that the stylesheets are inline, take their ghosts out of the flight
  // payload. Done after script inlining, because before it the payload is
  // still in a separate file.
  for (const url of stylesheetUrls) {
    html = stripFlightStylesheet(html, url);
  }

  // Any surviving `/_next/` reference is a request that will be made and will
  // fail — a 404 against the dev host, a CSP refusal inside an MCP host. The
  // check is deliberately blunt: an earlier version of this script exempted
  // references inside script text on the theory that they were inert data,
  // and that assumption cost a debugging session. The App Router reads them.
  const leftovers = [
    ...html.matchAll(/\/_next\/static\/(?:css|chunks|media)\/[^"'\\\s)]+/g),
  ].map((match) => match[0]);
  if (leftovers.length > 0) {
    console.error(
      `refusing to write: ${leftovers.length} un-inlined asset reference(s) ` +
        `remain: ${[...new Set(leftovers)].slice(0, 5).join(", ")}`,
    );
    process.exit(1);
  }

  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, html, "utf8");

  const kib = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(
    `inlined ${inlinedScripts} script(s) and ${inlinedStyles} stylesheet(s) ` +
      `-> ${TARGET} (${kib} KiB)`,
  );
}

main();
