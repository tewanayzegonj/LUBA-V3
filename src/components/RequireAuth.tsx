import { useAuth } from "@/hooks/use-auth";
import { LubaOrb } from "@/components/ui/luba-orb";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // Verifying the signed-in session — standalone scale orb, "connecting"
    // truthfully names the session/connectivity check in progress.
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <LubaOrb state="connecting" size={64} />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return children;
}
