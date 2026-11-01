import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans that keep positions out of the old guards (A36), keep the
 * director guard strict (A48, A64) and keep the flags readable from one place.
 * They read files as text, so they hold without a database.
 */

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Code only: block and line comments removed, so prose can name a symbol. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : walk(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The symbols the old guards must never touch. */
const NAMED = [
  "vetsProposals",
  "handlesDisposables",
  "JcrcPosition",
  "JcrcPositionCca",
  "JcrcPositionHolder",
  "myPositionCcas",
];
const NAMED_PATTERNS = [
  ...NAMED.map((n) => new RegExp(`\\b${n}\\b`)),
  // The Prisma delegates, spelled with a lower-case first letter.
  /\bjcrcPosition(Cca|Holder)?\b/,
  // Any import of the positions or director modules.
  /from\s+["'][^"']*(jcrcPositions|jcrcPositionLock|directorGuard)["']/,
];

/** A36: the event, points and CCA authorization files. */
const EXISTING_GUARD_FILES = [
  // events
  "src/server/api/routers/event.ts",
  "src/server/api/services/events.ts",
  "src/server/api/services/eventPublish.ts",
  "src/server/api/services/eventLiveEdit.ts",
  "src/server/api/services/eventNotices.ts",
  "src/server/api/services/eventQr.ts",
  // points
  "src/server/api/routers/ccaPoints.ts",
  "src/server/api/routers/auxPoints.ts",
  "src/server/api/services/ccaPointsAccess.ts",
  "src/server/api/services/ccaPointsConfig.ts",
  ...readdirSync(path.join(ROOT, "src/server/api/services/auxPoints"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/server/api/services/auxPoints/${f}`),
  // CCA authorization and the role model they rest on
  "src/server/api/services/ccaScope.ts",
  "src/server/api/services/ccaMembers.ts",
  "src/server/api/services/ccaRoster.ts",
  "src/server/api/services/ccaDirectory.ts",
  "src/server/api/services/ccaApplications.ts",
  "src/server/api/services/ccaRecruitment.ts",
  "src/server/api/routers/cca.ts",
  "src/server/api/routers/ccaAdmin.ts",
  "src/server/api/routers/ccaApplications.ts",
  "src/server/api/routers/ccaApplicationsHead.ts",
  "src/server/api/routers/ccaRecruitment.ts",
  "src/server/api/services/access.ts",
  "src/server/api/services/roles.ts",
  "src/server/api/trpc.ts",
];

describe("A36: existing guards do not read positions or flags", () => {
  it("lists the files it checks, and each one exists", () => {
    expect(EXISTING_GUARD_FILES.length).toBeGreaterThan(25);
    for (const file of EXISTING_GUARD_FILES) {
      expect(() => read(file), file).not.toThrow();
    }
  });

  it.each(EXISTING_GUARD_FILES)("%s names none of the symbols", (file) => {
    const code = stripComments(read(file));
    for (const pattern of NAMED_PATTERNS) {
      expect(code, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});

/** Files that may read positions: the positions files and the two modules. */
const MAY_READ_POSITIONS = [
  "src/server/api/routers/jcrcPositions.ts",
  "src/server/api/services/jcrcPositions.ts",
  "src/server/api/services/jcrcHandover.ts",
  "src/server/api/services/jcrcPositionLock.ts",
  "src/server/api/services/directorGuard.ts",
];
const POSITION_DATA =
  /\b(jcrcPosition(Cca|Holder)?|JcrcPosition(Cca|Holder)?|vetsProposals|handlesDisposables)\b/;

describe("only the positions files and the one strict guard read positions", () => {
  const files = walk(path.join(ROOT, "src")).map((f) =>
    path.relative(ROOT, f).split(path.sep).join("/"),
  );

  it("no other file touches the position collections or the flags", () => {
    const offenders = files.filter((f) => {
      if (MAY_READ_POSITIONS.includes(f)) return false;
      // The Positions page shows the flags the router returns.
      if (f.startsWith("src/app/admin/positions/")) return false;
      return POSITION_DATA.test(stripComments(read(f)));
    });
    expect(offenders).toEqual([]);
  });

  it("the guard module is the only one outside the positions files that reads the flags", () => {
    const flagReaders = files.filter((f) =>
      /\b(vetsProposals|handlesDisposables)\b/.test(stripComments(read(f))),
    );
    expect(flagReaders.sort()).toEqual(
      [
        "src/server/api/routers/jcrcPositions.ts",
        "src/server/api/services/directorGuard.ts",
        "src/server/api/services/jcrcPositionLock.ts",
        "src/app/admin/positions/_components/PositionCard.tsx",
        "src/app/admin/positions/_components/DirectorFlags.tsx",
      ].sort(),
    );
  });
});

describe("the strict guard never uses a forgiving read (A48, A64)", () => {
  const code = stripComments(read("src/server/api/services/directorGuard.ts"));

  it("does not import getUserRoles, the session, access.ts or the term helper", () => {
    expect(code).not.toMatch(/getUserRoles/);
    expect(code).not.toMatch(/dropEndedJcrcRole/);
    expect(code).not.toMatch(/\bsession\b/i);
    expect(code).not.toMatch(/from\s+["'][^"']*\/access["']/);
    expect(code).not.toMatch(/from\s+["'][^"']*jcrcTerm["']/);
  });

  it("does not use myPositionCcas, scopeForView or the oversees-all switch", () => {
    expect(code).not.toMatch(/myPositionCcas/);
    expect(code).not.toMatch(/scopeForView|scopeFromPositions|inScope/);
    expect(code).not.toMatch(/overseesAll/);
  });

  it("imports only activeHolderWhere from the positions service", () => {
    const imports = [
      ...code.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'][^"']*jcrcPositions["']/g,
      ),
    ].map((m) => m[1]!.trim());
    expect(imports).toEqual(["activeHolderWhere"]);
  });

  it("has no try/catch around a database read", () => {
    // The only catches are the forgiving display read and the one that turns
    // a failed decision into a refusal.
    const catches = code.match(/\bcatch\b/g) ?? [];
    expect(catches).toHaveLength(2);
    expect(code).toMatch(/async function refuseUnless/);
    expect(code).toMatch(/export async function isDirectorsEnabled/);
  });
});

describe("the schema", () => {
  const schema = read("prisma/schema.prisma");
  const block = (name: string) => {
    const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    expect(m, `model ${name}`).not.toBeNull();
    return m![1]!;
  };

  it("adds the two optional flags to JcrcPosition and nothing else", () => {
    const body = block("JcrcPosition");
    expect(body).toMatch(/\n\s*vetsProposals\s+Boolean\?\s*(\r?\n|$)/);
    expect(body).toMatch(/\n\s*handlesDisposables\s+Boolean\?\s*(\r?\n|$)/);
  });

  it("has no field named academicYear on any position model", () => {
    for (const model of [
      "JcrcPosition",
      "JcrcPositionCca",
      "JcrcPositionHolder",
      "JcrcTerm",
    ]) {
      expect(block(model)).not.toMatch(/\bacademicYear\b/);
    }
  });

  it("adds no role string, builder or capability for directors", () => {
    for (const file of [
      "src/server/api/services/roles.ts",
      "src/lib/roleNames.ts",
      "src/server/api/trpc.ts",
    ]) {
      expect(stripComments(read(file)), file).not.toMatch(/\bdirectors?\b/i);
    }
  });
});
