import { db } from "~/server/db";
import {
  buildFeed,
  tokenFromSegment,
} from "~/server/api/services/calendar/feed";

/**
 * The personal calendar feed, `/api/calendar/feed/<token>.ics`. A calendar app
 * cannot sign in, so the unguessable token in the path IS the credential: it
 * is per person, read-only, kept only as a hash and revocable (merge proposal
 * A11 and A28). Everything that decides what the response holds is in
 * services/calendar/feed.ts.
 *
 *  - GET only. A dynamic route, never cached by Next, and the response is
 *    `private, no-store` so no shared cache keeps a person's calendar.
 *  - The token is never logged here or in the service: no request URL, no
 *    header and no parameter is written anywhere. A failure logs its kind.
 *  - Refusals carry no detail: 401 for any token that opens nothing, 503 when
 *    the feed is off or a read failed.
 *  - There is no sign-in check and no middleware to allow-list: the app has
 *    none, and this route does not read the session.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
): Promise<Response> {
  const result = await buildFeed(db, tokenFromSegment(params.token));
  if (result.status !== 200) {
    return new Response(result.body, {
      status: result.status,
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(result.body, {
    status: 200,
    headers: {
      ...HEADERS,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="rhapp.ics"',
    },
  });
}
