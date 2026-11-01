import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { writeAudit } from "~/server/api/routers/admin";
import { activeHolderWhere } from "~/server/api/services/jcrcPositions";
import {
  ADMIN_ROLE,
  HALL_OFFICE_ROLE,
  SCRC_ROLE,
} from "~/server/api/services/roles";

/**
 * THE LOCK ON FLAGGED POSITIONS.
 *
 * A position with neither `vetsProposals` nor `handlesDisposables` keeps
 * #119's open editing: any JCRC member or admin, no audit row. A FLAGGED
 * position is a permission, so changing its holders or its CCA list, renaming
 * it and deleting it are refused for a plain `jcrc` member. An admin, an RF
 * (`scrc`) or a Hall Office member may; every such change writes an audit row.
 *
 * The flag is read from the stored row at each call (callers pass the row they
 * just read), never from a cache and never from `directors.enabled`: turning
 * the directors switch off removes the powers, not the lock.
 *
 * The one holder change left to a holder is the handover
 * (services/jcrcHandover.ts), which does not go through this lock.
 *
 * Positions-router procedures check admin through assertMayEditFlaggedPosition
 * with the caller's live roles. The staff panel (a later PR) calls the same
 * check with the staff caller's roles, so there is one rule.
 */

export const POSITION_LOCKED = "POSITION_LOCKED";

/** Who may edit a flagged position. A plain `jcrc` member is deliberately absent. */
const LOCK_OVERRIDE_ROLES: readonly string[] = [
  ADMIN_ROLE,
  SCRC_ROLE,
  HALL_OFFICE_ROLE,
];

/** The audit actions this lock writes. */
export const POSITION_AUDIT = {
  addHolder: "jcrcPosition.holder.add",
  removeHolder: "jcrcPosition.holder.remove",
  setCcas: "jcrcPosition.ccas.set",
  rename: "jcrcPosition.rename",
  delete: "jcrcPosition.delete",
  flagSet: "jcrcPosition.flag.set",
  flagClear: "jcrcPosition.flag.clear",
} as const;

type FlagFields = {
  vetsProposals?: boolean | null;
  handlesDisposables?: boolean | null;
};

/** A missing field means false. */
export function isFlaggedPosition(position: FlagFields): boolean {
  return (
    position.vetsProposals === true || position.handlesDisposables === true
  );
}

export function mayEditFlaggedPosition(roles: readonly string[]): boolean {
  return roles.some((r) => LOCK_OVERRIDE_ROLES.includes(r));
}

/** Throws POSITION_LOCKED unless the caller may edit a flagged position. */
export function assertMayEditFlaggedPosition(roles: readonly string[]): void {
  if (!mayEditFlaggedPosition(roles)) {
    throw new TRPCError({ code: "FORBIDDEN", message: POSITION_LOCKED });
  }
}

export type PositionSnapshot = {
  /** Current holders (rows not past their end date) and who assigned them. */
  holders: { userID: string; assignedBy: string }[];
  ccaIDs: number[];
};

/** The holders and CCAs of a position at this moment. */
export async function snapshotPosition(
  db: Pick<PrismaClient, "jcrcPositionHolder" | "jcrcPositionCca">,
  positionID: string,
  now: Date = new Date(),
): Promise<PositionSnapshot> {
  const [holders, links] = await Promise.all([
    db.jcrcPositionHolder.findMany({
      where: { positionID, ...activeHolderWhere(now) },
      select: { userID: true, assignedBy: true },
    }),
    db.jcrcPositionCca.findMany({
      where: { positionID },
      select: { ccaID: true },
    }),
  ]);
  return {
    holders: holders
      .map((h) => ({ userID: h.userID, assignedBy: h.assignedBy }))
      .sort((a, b) => a.userID.localeCompare(b.userID)),
    ccaIDs: [...new Set(links.map((l) => l.ccaID))].sort((a, b) => a - b),
  };
}

/** `holders: E1, E2; ccas: 9001, 9002`, the shape flag audit rows record. */
export function describeSnapshot(snapshot: PositionSnapshot): string {
  const holders = snapshot.holders.map((h) => h.userID).join(", ") || "none";
  const ccas = snapshot.ccaIDs.join(", ") || "none";
  return `holders: ${holders}; ccas: ${ccas}`;
}

/** Whether two lists hold the same members, ignoring order. */
export function sameMembers<T extends string | number>(
  a: readonly T[],
  b: readonly T[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
}

/**
 * One audit row for a successful change to a flagged position. Uses the same
 * writeAudit as role changes, which logs and swallows its own failure.
 */
export async function auditFlaggedChange(
  db: PrismaClient,
  entry: {
    actorUserID: string;
    actorRoles: readonly string[];
    action: (typeof POSITION_AUDIT)[keyof typeof POSITION_AUDIT];
    position: { id: string; name: string };
    targetUserID?: string;
    detail: string;
  },
): Promise<void> {
  await writeAudit(db, {
    actorUserID: entry.actorUserID,
    actorRoles: [...entry.actorRoles],
    targetUserID: entry.targetUserID,
    action: entry.action,
    reason: `position "${entry.position.name}" (${entry.position.id}): ${entry.detail}`,
  });
}
