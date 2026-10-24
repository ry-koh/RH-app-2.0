import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { applyRoleChange, writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { activeHolderWhere } from "~/server/api/services/jcrcPositions";
import {
  ADMIN_ROLE,
  forbiddenRoleCombination,
  holdsStaffRole,
  isGrantableRole,
  JCRC_ROLE,
  type GrantableRole,
} from "~/server/api/services/roles";

/**
 * JCRC SELF-HANDOVER (HOTO).
 *
 * An outgoing JCRC member hands over positions THEY HOLD to one or more
 * successors. Successors get `jcrc` and the positions at once; the outgoing
 * member keeps them until a step-out date they pick, then loses the positions
 * and, if those were their last, `jcrc` too.
 *
 * D-3 RELAXED, ON THIS PATH ONLY. The generic role path still refuses a jcrc
 * granting jcrc (ASSIGNABLE_BY.jcrc stays []). This dedicated path may, and
 * only in the one shape it exists for: the caller must hold `jcrc` and every
 * position being handed over, and the only role it ever adds is `jcrc`. It
 * goes through applyRoleChange, so the exclusion pair, the compare-and-set and
 * the audit row all still apply. RFs and Hall Office keep appointing and
 * removing JCRC directly from the staff page.
 */

/** Same cap as createPendingGrants: a grant is a bearer credential. */
const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const HANDOVER_REASON_MAX = 500;

export type HandoverInput = {
  actorUserID: string;
  positionIDs: readonly string[];
  successorIDs: readonly string[];
  stepOutAt: Date;
  reason?: string;
};

export type HandoverResult = {
  /** Successors who now hold `jcrc`. */
  granted: string[];
  /** Successors who have never signed in: a pending grant waits for them. */
  pending: string[];
  /** When the outgoing member's `jcrc` ends, or null if they keep it. */
  termEndsAt: Date | null;
};

const refuse = (message: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message });
};

function storedRoles(
  row: { roles: string[]; role: string | null } | null,
): string[] {
  if (row?.roles?.length) return row.roles;
  return row?.role ? [row.role] : [];
}

type SuccessorPlan = {
  userID: string;
  /** null: never signed in, so the grant waits in PendingRoleGrant. */
  stored: string[] | null;
};

async function planSuccessors(
  db: PrismaClient,
  actorUserID: string,
  successorIDs: readonly string[],
): Promise<SuccessorPlan[]> {
  const ids = [...new Set(successorIDs)];
  if (ids.length === 0) refuse("NO_SUCCESSOR");
  if (ids.includes(actorUserID)) refuse("SUCCESSOR_IS_YOU");
  const rows = await db.userRole.findMany({
    where: { userID: { in: ids } },
    select: { userID: true, roles: true, role: true },
  });
  return ids.map((userID) => {
    const row = rows.find((r) => r.userID === userID) ?? null;
    const stored = row ? storedRoles(row) : null;
    // The exclusion pair, checked up front so a refusal writes nothing.
    if (stored && holdsStaffRole(stored)) refuse("SUCCESSOR_IS_STAFF");
    return { userID, stored };
  });
}

async function grantJcrc(
  db: PrismaClient,
  actorUserID: string,
  actorRoles: string[],
  plan: SuccessorPlan,
  reason: string,
  now: Date,
): Promise<"granted" | "pending"> {
  if (plan.stored === null) {
    const prior = await db.pendingRoleGrant.findUnique({
      where: { userID: plan.userID },
    });
    const roles = [...new Set([...(prior?.roles ?? []), JCRC_ROLE])];
    if (forbiddenRoleCombination(roles)) refuse("SUCCESSOR_IS_STAFF");
    const expiresAt = new Date(now.getTime() + PENDING_TTL_MS);
    const laterExpiry =
      prior && prior.expiresAt > expiresAt ? prior.expiresAt : expiresAt;
    await db.pendingRoleGrant.upsert({
      where: { userID: plan.userID },
      create: {
        userID: plan.userID,
        roles,
        createdBy: actorUserID,
        createdByRoles: actorRoles,
        expiresAt: laterExpiry,
        reason,
      },
      update: {
        roles,
        expiresAt: laterExpiry,
        createdBy: actorUserID,
        createdByRoles: actorRoles,
        reason,
      },
    });
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID: plan.userID,
      action: "pending.create",
      rolesAfter: roles,
      reason,
    });
    return "pending";
  }

  // A successor taking on a position starts a fresh term.
  await db.jcrcTerm.deleteMany({ where: { userID: plan.userID } });
  if (plan.stored.includes(ADMIN_ROLE) || plan.stored.includes(JCRC_ROLE)) {
    return "granted";
  }
  const before = plan.stored.filter(isGrantableRole);
  await applyRoleChange({
    db,
    actorUserID,
    actorRoles,
    targetUserID: plan.userID,
    before,
    after: [...before, JCRC_ROLE],
    added: [JCRC_ROLE],
    removed: [],
    reason,
  });
  return "granted";
}

/**
 * The latest end date across a user's holder rows, or null if any is open (or
 * they hold none). Reads ended-but-unswept rows too, so a step-out of "now"
 * still yields a term end.
 */
async function termEndFor(
  db: PrismaClient,
  userID: string,
): Promise<Date | null> {
  const rows = await db.jcrcPositionHolder.findMany({
    where: { userID },
    select: { endsAt: true },
  });
  if (rows.some((r) => r.endsAt === null)) return null;
  const ends = rows.map((r) => r.endsAt!.getTime());
  return ends.length === 0 ? null : new Date(Math.max(...ends));
}

export async function handOverPositions(
  db: PrismaClient,
  input: HandoverInput,
  now: Date = new Date(),
): Promise<HandoverResult> {
  const { actorUserID } = input;
  const actorRoles = await getUserRoles(db, actorUserID); // I-5 live read
  if (!actorRoles.includes(JCRC_ROLE)) refuse("NOT_JCRC");

  const positionIDs = [...new Set(input.positionIDs)];
  if (positionIDs.length === 0) refuse("NO_POSITION");
  const held = await db.jcrcPositionHolder.findMany({
    where: {
      userID: actorUserID,
      positionID: { in: positionIDs },
      ...activeHolderWhere(now),
    },
    select: { positionID: true },
  });
  if (held.length !== positionIDs.length) refuse("NOT_YOUR_POSITION");

  const positions = await db.jcrcPosition.findMany({
    where: { id: { in: positionIDs } },
    select: { name: true },
  });
  const stepOutAt =
    input.stepOutAt.getTime() < now.getTime() ? now : input.stepOutAt;
  const reason = [
    `Handover of ${positions.map((p) => p.name).join(", ")}`,
    `step-out ${stepOutAt.toISOString()}`,
    input.reason,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, HANDOVER_REASON_MAX);

  const plans = await planSuccessors(db, actorUserID, input.successorIDs);

  const granted: string[] = [];
  const pending: string[] = [];
  for (const plan of plans) {
    const outcome = await grantJcrc(
      db,
      actorUserID,
      actorRoles,
      plan,
      reason,
      now,
    );
    (outcome === "granted" ? granted : pending).push(plan.userID);
    for (const positionID of positionIDs) {
      await db.jcrcPositionHolder.upsert({
        where: { positionID_userID: { positionID, userID: plan.userID } },
        create: {
          positionID,
          userID: plan.userID,
          assignedBy: actorUserID,
          endsAt: null,
        },
        update: { endsAt: null, assignedBy: actorUserID, assignedAt: now },
      });
    }
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID: plan.userID,
      action: "jcrc.handover",
      reason,
    });
  }

  await db.jcrcPositionHolder.updateMany({
    where: { userID: actorUserID, positionID: { in: positionIDs } },
    data: { endsAt: stepOutAt },
  });
  const termEndsAt = await termEndFor(db, actorUserID);
  if (termEndsAt) {
    await db.jcrcTerm.upsert({
      where: { userID: actorUserID },
      create: { userID: actorUserID, endsAt: termEndsAt },
      update: { endsAt: termEndsAt, setAt: now },
    });
  }
  if (stepOutAt.getTime() <= now.getTime()) await sweepEndedJcrcTerms(db, now);
  return { granted, pending, termEndsAt };
}

/**
 * Move or cancel the caller's own step-out date. `null` cancels it: they keep
 * their handed-over positions (alongside the successors) and `jcrc`.
 */
export async function setStepOut(
  db: PrismaClient,
  actorUserID: string,
  stepOutAt: Date | null,
  now: Date = new Date(),
): Promise<{ termEndsAt: Date | null }> {
  const pendingRows = { userID: actorUserID, endsAt: { gt: now } };
  const count = await db.jcrcPositionHolder.count({ where: pendingRows });
  if (count === 0) refuse("NO_STEP_OUT_PENDING");
  const endsAt =
    stepOutAt && stepOutAt.getTime() < now.getTime() ? now : stepOutAt;
  await db.jcrcPositionHolder.updateMany({
    where: pendingRows,
    data: { endsAt },
  });
  const termEndsAt = await termEndFor(db, actorUserID);
  if (termEndsAt) {
    await db.jcrcTerm.upsert({
      where: { userID: actorUserID },
      create: { userID: actorUserID, endsAt: termEndsAt },
      update: { endsAt: termEndsAt, setAt: now },
    });
  } else {
    await db.jcrcTerm.deleteMany({ where: { userID: actorUserID } });
  }
  if (endsAt && endsAt.getTime() <= now.getTime()) {
    await sweepEndedJcrcTerms(db, now);
  }
  return { termEndsAt };
}

/**
 * Finish every handover whose step-out date has passed: drop the ended holder
 * rows and remove `jcrc` from members whose term ended, with the usual audit
 * row. There is no cron in this app, so this runs lazily from the positions
 * surface; until it runs, getUserRoles already treats `jcrc` as gone.
 *
 * Idempotent and safe to run concurrently: a lost compare-and-set leaves the
 * term in place for the next sweep.
 */
export async function sweepEndedJcrcTerms(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ ended: number }> {
  // `not: null` is load-bearing: Prisma's Mongo connector matches a stored
  // null on `lte`, which would delete every open-ended holder.
  await db.jcrcPositionHolder.deleteMany({
    where: { endsAt: { lte: now, not: null } },
  });
  const due = await db.jcrcTerm.findMany({ where: { endsAt: { lte: now } } });
  let ended = 0;
  for (const term of due) {
    const row = await db.userRole.findUnique({
      where: { userID: term.userID },
      select: { roles: true, role: true },
    });
    const before = storedRoles(row).filter(isGrantableRole);
    if (before.includes(JCRC_ROLE)) {
      try {
        await applyRoleChange({
          db,
          actorUserID: term.userID,
          actorRoles: before,
          targetUserID: term.userID,
          before,
          after: before.filter((r): r is GrantableRole => r !== JCRC_ROLE),
          added: [],
          removed: [JCRC_ROLE],
          reason: "JCRC handover: step-out date reached",
        });
      } catch (err) {
        if (err instanceof TRPCError && err.code === "CONFLICT") continue;
        throw err;
      }
      ended += 1;
    }
    await db.jcrcTerm.deleteMany({
      where: { userID: term.userID, endsAt: { lte: now } },
    });
  }
  return { ended };
}
