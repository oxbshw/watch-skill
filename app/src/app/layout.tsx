/**
 * The document shell.
 *
 * Deliberately thin. Everything the workspace does needs a live transport and
 * therefore runs on the client; this exists to own `<html>`, the stylesheet,
 * and the one piece of state that must be correct before React mounts — the
 * theme, applied from a blocking inline script so the page never paints light
 * and then snaps to dark.
 *
 * No font links, no analytics, no preconnect. Under the workspace CSP there
 * are no remote origins at all, and a remote font would not fail loudly — it
 * would silently fall back and quietly break the zero-egress gate.
 */
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Watch Skill workspace",
  description: "Live observation, evidence and verification workspace.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The workspace is a dense evidence tool; both themes are first-class and
  // the browser is told so, which is what makes form controls and scrollbars
  // follow the theme instead of staying stubbornly light.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

/** Applied before first paint. A theme that arrives with React is a theme the
 *  user watches flip. Wrapped in try/catch because a storage-blocked host must
 *  degrade to the media query, not to a blank page. */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("ws-theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
