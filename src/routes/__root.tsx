import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SettingsProvider } from "@/lib/settings";
import { WalletProviders } from "@/components/wallet/WalletProviders";
import { btn } from "@/components/kit";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="ticket max-w-md p-10 text-center">
        <p className="station-code text-amber">Station 404</p>
        <h1 className="display mt-3 text-5xl text-cream">Off the map.</h1>
        <p className="mt-3 text-sm text-cream/75">No train stops at this address. It may have moved or never existed.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/" className={btn()}>Back home</Link>
          <Link to="/app" className={btn({ variant: "line" })}>Terminal</Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="ticket max-w-md p-10 text-center">
        <p className="station-code text-amber">Signal fault</p>
        <h1 className="display mt-3 text-3xl text-cream">This page didn't load</h1>
        <p className="mt-2 text-sm text-cream/75">{error instanceof Error ? error.message : "Something went wrong."}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button onClick={() => { router.invalidate(); reset(); }} className={btn()}>Try again</button>
          <a href="/" className={btn({ variant: "line" })}>Go home</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Studio Loco" },
      { name: "description", content: "Studio Loco — Meteora DLMM liquidity tools and an honest coordination lab on Solana." },
      { name: "theme-color", content: "#061F42" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <WalletProviders>
          <Outlet />
        </WalletProviders>
      </SettingsProvider>
    </QueryClientProvider>
  );
}
