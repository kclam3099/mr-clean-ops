import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Route protection is a UX convenience only — Row Level Security is the
// real authorization boundary (Blueprint v0.2 SS F). Every request under
// a protected group still hits RLS regardless of what this file does.
const STAFF_PREFIX = "/my";
const PUBLIC_PATHS = new Set(["/login"]);

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Required even though the result isn't used directly below — this is
  // what actually refreshes an expiring session cookie on every request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicPath = PUBLIC_PATHS.has(pathname);

  if (!user && !isPublicPath) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname === "/login") {
    // Role-aware redirect (staff -> /my/today, master -> /dashboard)
    // lands once profiles/RLS are live (Phase 1 Build Plan step 4) — a
    // real profiles row is required to know which home page is correct.
    const homePath = pathname.startsWith(STAFF_PREFIX) ? "/my/today" : "/dashboard";
    return NextResponse.redirect(new URL(homePath, request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match every route except static assets and Next.js internals, so
     * the session cookie stays refreshed everywhere it's needed.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
