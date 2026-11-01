import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import type { FeedbackCategory } from "~/lib/schemas/feedback";
import { rateLimit } from "~/lib/rateLimit";
import { notify } from "./notifications";
import { ADMIN_ROLE } from "./roles";

export const FEEDBACK_FLAG_KEY = "feedback.enabled";
export const FEEDBACK_DISABLED = "FEEDBACK_DISABLED";

/** Per user: five reports an hour. */
export const FEEDBACK_LIMIT = 5;
export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;

/** Fail CLOSED: an absent row, any value but "on", or a failed read is off. */
export async function isFeedbackEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: FEEDBACK_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertFeedbackEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isFeedbackEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: FEEDBACK_DISABLED });
  }
}

/**
 * Store one report and tell every admin, in ONE transaction: if the notice
 * cannot be written the report is not saved either (A6). The notice names no
 * one and copies none of the text; it points at the admin screen. While
 * `notifications.enabled` is off `notify` writes nothing and the report still
 * saves.
 */
export async function submitFeedback(
  db: PrismaClient,
  userID: string,
  input: { category: FeedbackCategory; message: string },
): Promise<{ id: string }> {
  const limited = await rateLimit(
    `feedback:${userID}`,
    FEEDBACK_LIMIT,
    FEEDBACK_WINDOW_MS,
  );
  if (!limited.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${limited.retryAfter}`,
    });
  }
  return db.$transaction(async (tx) => {
    const row = await tx.feedback.create({
      data: { userID, category: input.category, message: input.message },
      select: { id: true },
    });
    const admins = await tx.userRole.findMany({
      where: { OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }] },
      select: { userID: true },
    });
    await notify(tx, {
      recipients: admins.map((a) => a.userID),
      kind: "feedback.submitted",
      title: "New feedback",
      href: "/admin/feedback",
    });
    return row;
  });
}
