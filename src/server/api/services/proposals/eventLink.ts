import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { headEventHref } from "~/lib/proposals/links";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_PUBLIC_DESCRIPTION_MAX,
  EVENT_TITLE_MAX,
  normalizeStatus,
} from "~/lib/schemas/event";
import { createEventRow } from "~/server/api/services/eventDraft";
import {
  areEventsEnabled,
  assertEventsEnabled,
  nextEventId,
} from "~/server/api/services/events";
import { notify } from "~/server/api/services/notifications";
import { assertCcaHead, PROPOSAL_NOT_FOUND } from "./access";
import { assertWithinLimit } from "./limits";

/**
 * From an approved proposal to ONE linked Event draft (merge proposal 4.7).
 *
 * The draft cannot join the approval's transaction (`nextEventId` takes the
 * plain client and `event.create` has no transaction), so it is made right
 * AFTER the approval commits, in this order:
 *  1. read the proposal;
 *  2. if it already points at an Event that exists, stop;
 *  3. allocate an id with `nextEventId`;
 *  4. compare-and-set `Proposal.eventID` from the value read in 1 to the new id;
 *  5. ONLY if that changed one row, create the Event row.
 * Only one of any number of racing callers wins step 4, so at most one draft
 * is ever created. A failure after 4 leaves `eventID` pointing at no Event: a
 * reader sees "the draft is missing" and the Create event button repeats 3 to
 * 5 with that dangling value expected. A skipped counter value is harmless.
 *
 * The automatic step runs only while `events.enabled` is on, and a failure in
 * it never undoes or fails the approval (it logs the error name and returns).
 * Nothing here publishes: publishing stays `event.publish`, a head's action.
 *
 * Nothing in `event.*` reads any of this (A32); the dependency runs one way.
 */

export const EVENT_NOT_APPROVED = "PROPOSAL_NOT_APPROVED";

type LinkDb = PrismaClient;

type Source = {
  id: string;
  ccaID: number;
  createdBy: string | null;
  title: string;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
  willBeEvent: boolean | null;
  status: string;
  eventID: number | null;
};

const SOURCE_SELECT = {
  id: true,
  ccaID: true,
  createdBy: true,
  title: true,
  description: true,
  blastMessage: true,
  plannedStart: true,
  plannedEnd: true,
  willBeEvent: true,
  status: true,
  eventID: true,
} as const;

const loadSource = (db: LinkDb, id: string): Promise<Source | null> =>
  db.proposal.findUnique({ where: { id }, select: SOURCE_SELECT });

/** What a reader of a proposal may learn of its Event: id, status and title. */
export type LinkedEvent = {
  eventID: number;
  status: string;
  title: string | null;
};

/**
 * The linked Event, or null if there is none or it no longer exists
 * (`deleteDraft`). Every read of the link goes through here.
 */
export async function readLinkedEvent(
  db: Pick<PrismaClient, "event">,
  eventID: number | null,
): Promise<LinkedEvent | null> {
  if (eventID === null) return null;
  const event = await db.event.findUnique({
    where: { eventID },
    select: { eventID: true, status: true, title: true },
  });
  if (!event) return null;
  return {
    eventID: event.eventID,
    status: normalizeStatus(event.status),
    title: event.title ?? null,
  };
}

export type EventLinkView = {
  willBeEvent: boolean;
  /** The Event, if it exists: its id, status and title and nothing else. */
  event: LinkedEvent | null;
  /** The proposal points at an Event that is gone. */
  eventMissing: boolean;
  eventsEnabled: boolean;
  canCreateEvent: boolean;
};

export async function readEventLinkView(
  db: LinkDb,
  row: Pick<Source, "willBeEvent" | "status" | "eventID">,
  isHead: boolean,
): Promise<EventLinkView> {
  const [event, eventsEnabled] = await Promise.all([
    readLinkedEvent(db, row.eventID),
    areEventsEnabled(db),
  ]);
  return {
    willBeEvent: row.willBeEvent === true,
    event,
    eventMissing: row.eventID !== null && event === null,
    eventsEnabled,
    canCreateEvent:
      isHead && eventsEnabled && row.status === "cleared" && event === null,
  };
}

type Outcome =
  | { outcome: "created"; eventID: number }
  | { outcome: "already_linked"; eventID: number }
  | { outcome: "lost_race" };

/** A missing key and a stored null do not match the same query on MongoDB. */
const eventIDIs = (expected: number | null) =>
  expected === null
    ? { OR: [{ eventID: null }, { eventID: { isSet: false } }] }
    : { eventID: expected };

function eventRowFrom(source: Source, eventID: number, ownerID: string) {
  const start = source.plannedStart;
  const end = source.plannedEnd;
  const timed = start !== null && end !== null && end > start;
  const blast = (source.blastMessage ?? "").trim();
  const description = source.description.trim();
  // Only these fields copy. The poster, location, facility, capacity,
  // category, document link, budget lines and status stay on the proposal.
  return {
    eventID,
    ccaID: source.ccaID,
    createdBy: ownerID,
    title: source.title.trim().slice(0, EVENT_TITLE_MAX),
    description:
      description === "" ? null : description.slice(0, EVENT_DESCRIPTION_MAX),
    startTime: timed ? start : null,
    endTime: timed ? end : null,
    location: null,
    facilityID: null,
    capacity: null,
    publicDescription:
      blast === "" ? null : blast.slice(0, EVENT_PUBLIC_DESCRIPTION_MAX),
  };
}

async function linkAndCreate(
  db: LinkDb,
  source: Source,
  ownerID: string,
): Promise<Outcome> {
  const expected = source.eventID;
  if (expected !== null) {
    const there = await readLinkedEvent(db, expected);
    if (there) return { outcome: "already_linked", eventID: expected };
  }
  const eventID = await nextEventId(db);
  const claimed = await db.proposal.updateMany({
    where: {
      id: source.id,
      ccaID: source.ccaID,
      status: "cleared",
      ...eventIDIs(expected),
    },
    data: { eventID },
  });
  if (claimed.count !== 1) return { outcome: "lost_race" };
  await createEventRow(db, eventRowFrom(source, eventID, ownerID));
  return { outcome: "created", eventID };
}

const logName = (evt: string, err: unknown) =>
  console.error(
    JSON.stringify({
      evt,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );

/** Tell the CCA's heads their draft exists. Best effort, never throws. */
async function noticeDraftMade(
  db: LinkDb,
  source: Source,
  eventID: number,
): Promise<void> {
  try {
    const heads = await db.ccaHead.findMany({
      where: { ccaID: source.ccaID },
      select: { userID: true },
    });
    await notify(db, {
      recipients: heads.map((h) => h.userID),
      kind: "proposal.event_drafted",
      title: "An event draft was made from your approved proposal",
      body: source.title,
      href: headEventHref(source.ccaID, eventID),
    });
  } catch (err) {
    logName("proposal_event_notice_failed", err);
  }
}

/**
 * Run right after an approval commits. Makes the draft when the head asked for
 * one and `events.enabled` is on. NEVER throws: whatever goes wrong is logged
 * by error name and the approval stands; the Create event button recovers.
 *
 * The draft's owner is the proposal's creator. If their id was cleared by
 * account deletion (B16) no draft is made here, since the director who
 * approved must not own it; a head can press the button, which then makes them
 * the owner.
 */
export async function draftEventAfterApproval(
  db: LinkDb,
  proposalID: string,
): Promise<void> {
  try {
    const source = await loadSource(db, proposalID);
    if (!source || source.status !== "cleared") return;
    if (source.willBeEvent !== true) return;
    if (!(await areEventsEnabled(db))) return;
    if (source.createdBy === null) {
      console.error(JSON.stringify({ evt: "proposal_event_no_owner" }));
      return;
    }
    const result = await linkAndCreate(db, source, source.createdBy);
    if (result.outcome === "created") {
      await noticeDraftMade(db, source, result.eventID);
    }
  } catch (err) {
    logName("proposal_event_draft_failed", err);
  }
}

/**
 * The Create event button. A head of the proposal's CCA, by the strict guard,
 * with both flags on (a failed flag read is off). A director who is not also a
 * head cannot press it: the draft belongs to the CCA's heads, who alone can
 * open and publish it. Safe to press again, or at the same moment as the
 * automatic step: only one compare-and-set wins.
 */
export async function createEventFromProposal(
  db: LinkDb,
  userID: string,
  id: string,
): Promise<{ created: boolean; eventID: number | null }> {
  await assertEventsEnabled(db);
  const source = await loadSource(db, id);
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  await assertCcaHead(db, userID, source.ccaID, { hideExistence: true });
  await assertWithinLimit("createEvent", userID);
  if (source.status !== "cleared") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: EVENT_NOT_APPROVED,
    });
  }
  const result = await linkAndCreate(db, source, source.createdBy ?? userID);
  if (result.outcome === "lost_race") {
    const now = await loadSource(db, id);
    return { created: false, eventID: now?.eventID ?? null };
  }
  return { created: result.outcome === "created", eventID: result.eventID };
}
