/** Plain-language copy for the jcrcPositions router's refusal codes. */
const COPY: Record<string, string> = {
  NAME_TAKEN: "There's already a position with that name.",
  POSITION_NOT_FOUND: "That position no longer exists. Reload the page.",
  UNKNOWN_CCA: "One of those CCAs no longer exists. Reload the page.",
  TARGET_NOT_JCRC:
    "That person isn't on the JCRC. An RF or Hall Office appoints JCRC members first.",
  NOT_JCRC: "Only JCRC members can do this.",
  NOT_YOUR_POSITION: "You can only hand over positions you hold.",
  NO_SUCCESSOR: "Add at least one successor.",
  SUCCESSOR_IS_YOU: "You can't hand a position over to yourself.",
  SUCCESSOR_IS_STAFF: "An RF or Hall Office member can't also be on the JCRC.",
  NO_STEP_OUT_PENDING: "You don't have a step-out date to change.",
  CONFLICT: "Someone changed this at the same time. Reload and try again.",
};

export function positionsErrorCopy(message: string | undefined): string {
  return (message && COPY[message]) ?? "That didn't work. Try again.";
}
