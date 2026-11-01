import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { headProposalHref } from "~/lib/proposals/links";
import { REVIEW_MOVES, type ReviewAction } from "~/lib/proposals/status";
import { notify } from "~/server/api/services/notifications";
import { assertProposalDirector, readSelfApproved } from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { assertWithinLimit } from "./limits";
import {
  PROPOSAL_CONFLICT,
  transitionProposal,
  type TransitionedProposal,
} from "./transition";

/**
 * A director approves, returns or finishes a proposal: three moves, one path.
 *
 * WHO MAY ACT is worked out here, every time, from the stored rows:
 *  1. load the proposal and take its CCA from the STORED row (the browser sends
 *     an id and a version, never a CCA or a position);
 *  2. ask the strict guard (`assertProposalDirector`, which is directorGuard's
 *     `isDirectorOf`) whether this person is a director of THAT CCA now. A
 *     read that throws refuses, writes nothing and logs the error name only.
 *     Anyone else gets the same NOT_FOUND a missing id gets;
 *  3. spend the person's hourly budget (after the guard, so a person who may
 *     not act writes no counter);
 *  4. check the proposal is in the one status this move starts from, at the
 *     version the director read (CONFLICT otherwise). A draft is invisible to
 *     directors, so it answers NOT_FOUND (B19);
 *  5. `transitionProposal`: one compare-and-set, the history row, the audit
 *     row and the head's notice in ONE transaction. If the notice cannot be
 *     written the move is rolled back with it.
 *
 * Not used, on purpose: getUserRoles, the session's roles, myPositionCcas, the
 * oversees-all switch. A director who also heads the CCA may approve their own
 * proposal; the history then carries the self-approved label, worked out in
 * the same transaction (the RFs read it first, and a second rule would add no
 * second reader). RHApp does not wait for, send or record the RF email:
 * `cleared` means only that the director approved.
 */

export type ReviewInput = { id: string; version: number };
export type ReviewResult = {
  id: string;
  version: number;
  status: "cleared" | "needs_action" | "finished";
};

type Extras = {
  /** The approval note or the return reason, stored in history. */
  note: string | null;
};

const NOTICE: Record<
  ReviewAction,
  { kind: string; title: string; withNote: boolean }
> = {
  approve: {
    kind: "proposal.approved",
    title: "Your proposal was approved",
    withNote: true,
  },
  return: {
    kind: "proposal.returned",
    title: "Your proposal was returned to you",
    withNote: true,
  },
  finish: {
    kind: "proposal.finished",
    title: "Your proposal was marked finished",
    withNote: false,
  },
};

async function reviewMove(
  db: PrismaClient,
  userID: string,
  action: ReviewAction,
  input: ReviewInput,
  extras: Extras,
): Promise<ReviewResult> {
  const move = REVIEW_MOVES[action];
  const row = await db.proposal.findUnique({
    where: { id: input.id },
    select: { id: true, ccaID: true, status: true, version: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  await assertProposalDirector(db, userID, row.ccaID, {
    hideExistence: true,
  });
  await assertWithinLimit(action, userID);

  if (row.status === "draft") {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  if (row.status !== move.from || row.version !== input.version) {
    throw new TRPCError({ code: "CONFLICT", message: PROPOSAL_CONFLICT });
  }

  const moved = await transitionProposal(
    db,
    {
      proposalID: row.id,
      from: move.from,
      to: move.to,
      actorID: userID,
      expectedVersion: input.version,
      note: extras.note,
      ...(action === "approve" && { approverID: userID }),
    },
    {
      ...(action === "approve" && {
        selfApproved: (tx, proposal) => readSelfApproved(tx, userID, proposal),
      }),
      inTransaction: (tx, proposal) =>
        noticeToHeads(tx, action, proposal, userID, extras.note),
    },
  );
  return { id: moved.id, version: moved.version, status: move.to };
}

/**
 * Tell the CCA's heads, except the person who just acted (they know). Written
 * on the transaction client. Recipients come from CcaHead rows, never from the
 * request. The note or reason goes in the notice body; it is the head's own
 * proposal and the head is who it is for.
 */
async function noticeToHeads(
  tx: Prisma.TransactionClient,
  action: ReviewAction,
  proposal: TransitionedProposal,
  actorID: string,
  note: string | null,
): Promise<void> {
  const heads = await tx.ccaHead.findMany({
    where: { ccaID: proposal.ccaID },
    select: { userID: true },
  });
  const spec = NOTICE[action];
  await notify(tx, {
    recipients: heads.map((h) => h.userID).filter((id) => id !== actorID),
    kind: spec.kind,
    title: spec.title,
    body:
      spec.withNote && note
        ? `${proposal.title}: ${note}`.slice(0, 1000)
        : proposal.title,
    href: headProposalHref(proposal.ccaID, proposal.id),
  });
}

export function approveProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput & { note?: string | null | undefined },
): Promise<ReviewResult> {
  return reviewMove(db, userID, "approve", input, { note: input.note ?? null });
}

export function returnProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput & { reason: string },
): Promise<ReviewResult> {
  return reviewMove(db, userID, "return", input, { note: input.reason });
}

export function finishProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput,
): Promise<ReviewResult> {
  return reviewMove(db, userID, "finish", input, { note: null });
}
