import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TEST of the doctor's "Director positions" section (Q23) against
 * the LOCAL development database. It runs the real script as a child process,
 * reads what it prints, and checks that it changed nothing.
 *
 * The local database may hold other rows, so each assertion looks for this
 * test's own rows (users E99907xx, positions "TEST ...") in the output, and
 * the tests that need an otherwise empty director setup say so and stand down
 * when the database has other flagged positions.
 */

const SCRIPT = join(process.cwd(), "scripts", "remediation", "rbac-doctor.mjs");
const U = { good: "E9990701", bad: "E9990702", other: "E9990703" };
const IDS = Object.values(U);
const DIRECTORS_FLAG = "directors.enabled";
const WATCHED = [
  "jcrcPosition",
  "jcrcPositionCca",
  "jcrcPositionHolder",
  "jcrcTerm",
  "userRole",
  "systemFlag",
  "roleAuditLog",
] as const;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "rbac-doctor director checks (local database)",
  { timeout: 180_000 },
  () => {
    let db: PrismaClient;
    let originalFlag: string | null = null;

    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [SCRIPT, "--names", ...args], {
        encoding: "utf8",
        env: process.env,
        timeout: 120_000,
      });
      return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
    };
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const name of WATCHED) {
        out[name] = await (
          db[name] as unknown as { count: () => Promise<number> }
        ).count();
      }
      return out;
    };
    const setDirectors = async (value: string | null) => {
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key: DIRECTORS_FLAG } });
      } else {
        await db.systemFlag.upsert({
          where: { key: DIRECTORS_FLAG },
          create: { key: DIRECTORS_FLAG, value },
          update: { value },
        });
      }
    };
    const clean = async () => {
      const found = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST " } },
        select: { id: true },
      });
      const ids = found.map((p) => p.id);
      await db.jcrcPositionCca.deleteMany({
        where: { positionID: { in: ids } },
      });
      await db.jcrcPositionHolder.deleteMany({
        where: { OR: [{ positionID: { in: ids } }, { userID: { in: IDS } }] },
      });
      await db.jcrcPosition.deleteMany({ where: { id: { in: ids } } });
      await db.userRole.deleteMany({ where: { userID: { in: IDS } } });
    };
    const position = (
      name: string,
      flags: { vets?: boolean; social?: boolean },
    ) =>
      db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          vetsProposals: flags.vets ?? false,
          handlesDisposables: flags.social ?? false,
        },
      });
    const hold = (positionID: string, userID: string) =>
      db.jcrcPositionHolder.create({
        data: { positionID, userID, assignedBy: U.other },
      });
    const role = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: {
          userID,
          roles,
          role: "",
          updatedAt: new Date(),
          updatedBy: "test",
        },
      });
    /** True when the database holds flagged positions that are not this test's. */
    const hasOtherFlagged = async () =>
      (await db.jcrcPosition.count({
        where: {
          OR: [{ vetsProposals: true }, { handlesDisposables: true }],
          NOT: { name: { startsWith: "TEST " } },
        },
      })) > 0;

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      originalFlag =
        (await db.systemFlag.findUnique({ where: { key: DIRECTORS_FLAG } }))
          ?.value ?? null;
    });
    beforeEach(async () => {
      await clean();
      await setDirectors(null);
    });
    afterAll(async () => {
      if (db) {
        await clean();
        await setDirectors(originalFlag);
        await db.$disconnect();
      }
    });

    it("warns clearly about a second handlesDisposables flag, and fails the run", async () => {
      await position("Social A", { social: true });
      await position("Social B", { social: true });
      const { out, status } = run();
      expect(out).toContain(
        "more than one position flagged handlesDisposables",
      );
      expect(out).toMatch(/TEST Social A, TEST Social B/);
      expect(out).toMatch(/WARNING: a second flag removes the power silently/);
      expect(status).toBe(1);
    });

    it("lists a holder of a flagged position who lacks jcrc, as a failing line", async () => {
      const p = await position("Sports", { vets: true });
      await role(U.good, ["resident", "jcrc"]);
      await role(U.bad, ["resident"]);
      await hold(p.id, U.good);
      await hold(p.id, U.bad);
      const { out, status } = run();
      expect(out).toMatch(
        /holders of flagged positions without jcrc[.\s]+\d+\s+<- RED/,
      );
      expect(out).toContain(`${U.bad} on TEST Sports`);
      expect(out).not.toContain(`${U.good} on TEST Sports`);
      expect(status).toBe(1);
    });

    it("lists CCAs without a qualifying director as informational until gating, RED once gating", async () => {
      await position("Empty", { vets: true });
      const quiet = run();
      expect(quiet.out).toMatch(
        /CCAs with no current qualifying director[.\s]+\d+\s+\[informational\]/,
      );
      expect(quiet.out).toContain("not gating yet");

      const flagged = run("--directors");
      expect(flagged.out).toContain("GATING");
      expect(flagged.out).toMatch(
        /CCAs with no current qualifying director[.\s]+\d+\s+<- RED/,
      );
      expect(flagged.status).toBe(1);

      await setDirectors("on");
      const on = run();
      expect(on.out).toContain("directors.enabled is on");
      expect(on.out).toMatch(
        /CCAs with no current qualifying director[.\s]+\d+\s+<- RED/,
      );
    });

    it("reports the disposables position as missing, then vacant, then fine", async () => {
      // Only meaningful when the local database has no flagged positions of its own.
      if (await hasOtherFlagged()) return;
      const none = run("--directors");
      expect(none.out).toContain("no position is flagged");
      const p = await position("Social", { social: true });
      const vacant = run("--directors");
      expect(vacant.out).toMatch(
        /handlesDisposables position has a current qualifying holder[.\s]+1\s+<- RED/,
      );
      expect(vacant.out).toContain("TEST Social");
      await role(U.good, ["resident", "jcrc"]);
      await hold(p.id, U.good);
      const fine = run("--directors");
      expect(fine.out).toMatch(
        /handlesDisposables position has a current qualifying holder[.\s]+0(?!\d)/,
      );
    });

    it("shows every check at zero when the setup is complete", async () => {
      if (await hasOtherFlagged()) return;
      const ccas = await db.cCA.findMany({ select: { ccaID: true } });
      const p = await position("All", { vets: true, social: true });
      for (const c of ccas) {
        await db.jcrcPositionCca.create({
          data: { positionID: p.id, ccaID: c.ccaID, addedBy: "test" },
        });
      }
      await role(U.good, ["resident", "jcrc"]);
      await hold(p.id, U.good);
      const { out } = run("--directors");
      const zero = (label: string) =>
        new RegExp(`${label}[.\\s]+0(?!\\d)`).test(out);
      expect(zero("CCAs with no current qualifying director")).toBe(true);
      expect(zero("more than one position flagged handlesDisposables")).toBe(
        true,
      );
      expect(
        zero("handlesDisposables position has a current qualifying holder"),
      ).toBe(true);
      expect(zero("holders of flagged positions without jcrc")).toBe(true);
    });

    it("writes nothing: every collection it reads has the same row count after", async () => {
      const p = await position("Counted", { vets: true, social: true });
      await role(U.bad, ["resident"]);
      await hold(p.id, U.bad);
      const before = await counts();
      run("--directors");
      run();
      expect(await counts()).toEqual(before);
    });
  },
);
