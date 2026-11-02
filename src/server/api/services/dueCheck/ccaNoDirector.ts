import { ADMIN_ROLE, HALL_OFFICE_ROLE, SCRC_ROLE } from "~/lib/roleNames";
import { currentDirectorIDs } from "~/server/api/services/directorGuard";
import { isProposalsEnabled } from "~/server/api/services/proposals/flag";
import { normalizeStoredRoles } from "~/server/api/services/roles";
import type { DueKind } from "./types";

const STAFF_ROLES: readonly string[] = [
  ADMIN_ROLE,
  SCRC_ROLE,
  HALL_OFFICE_ROLE,
];
const NAME_MAX = 100;

/** Where staff fix it: the director positions panel on /scrc. */
export const NO_DIRECTOR_HREF = "/scrc";

/**
 * A CCA with no director who can act (4.2, A49), told to admins, RFs and Hall
 * Office once per CCA, person and Singapore day.
 *
 * Only while `proposals.enabled` is on (a failed read counts as off): without
 * proposals nobody needs a director. Whether the person is staff is read from
 * their stored roles, and each CCA's directors come from the strict guard's
 * `currentDirectorIDs`; none of these reads has a catch, so if one fails the
 * runner logs it and this kind writes nothing. `currentDirectorIDs` answers
 * [] while `directors.enabled` is off, which is the same "nobody can act"
 * that the notice at submit (B21) uses.
 *
 * It does not replace that notice. The one at submit is about a specific
 * proposal waiting now; this one is about the CCA, daily, until a director is
 * set. A person can get both for a CCA on the day a proposal is submitted.
 *
 * Catch-up: it computes only today's state under today's key, so nothing from
 * missed days exists to pile up, and each CCA is a separate fact. Hence "all".
 */
export const ccaNoDirectorKind: DueKind = {
  name: "cca_no_director",
  noticeKind: "cca.no_director",
  catchUp: "all",
  async due({ db, userID, now, dayKey }) {
    if (!(await isProposalsEnabled(db))) return [];

    const row = await db.userRole.findUnique({
      where: { userID },
      select: { roles: true, role: true },
    });
    const stored = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
    if (!normalizeStoredRoles(stored).some((r) => STAFF_ROLES.includes(r))) {
      return [];
    }

    const ccas = await db.cCA.findMany({
      select: { ccaID: true, ccaName: true },
      orderBy: { ccaID: "asc" },
    });
    const due = [];
    for (const cca of ccas) {
      if ((await currentDirectorIDs(db, cca.ccaID, now)).length > 0) continue;
      due.push({
        key: `due.cca_no_director:${cca.ccaID}:${dayKey}`,
        title: `${cca.ccaName.slice(0, NAME_MAX)} has no director to review its proposals`,
        body: "No one with a current JCRC role holds a director position for this CCA. Its proposals wait in review.",
        href: NO_DIRECTOR_HREF,
      });
    }
    return due;
  },
};
