"use client";

import Link from "next/link";

import { api } from "~/trpc/react";

/**
 * "or in the app" beside the footer's Google Form link. Draws nothing unless
 * `feedback.enabled` is known to be on: while loading, failed, signed out
 * (the query needs a session) or off, the footer reads exactly as before.
 */
export default function FeedbackFooterLink() {
  const enabled =
    api.feedback.enabled.useQuery(undefined, {
      retry: false,
      staleTime: 60_000,
    }).data?.enabled === true;
  if (!enabled) return null;
  return (
    <>
      {" "}
      or
      <Link href="/feedback" className="ml-1 underline hover:text-emerald-300">
        in the app
      </Link>
    </>
  );
}
