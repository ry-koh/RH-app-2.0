import { describe, expect, it } from "vitest";

import {
  claimDueCheck,
  DUE_CHECK_STORAGE_KEY,
  newDueCheckMemory,
  type DayStorage,
} from "~/lib/dueCheck/dailyGate";

const fakeStorage = (): DayStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
};

const throwing = (): DayStorage => ({
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
});

// 2026-11-02 15:59:59 UTC is 23:59:59 in Singapore; one second later is
// Singapore midnight, the next day.
const BEFORE_MIDNIGHT = new Date("2026-11-02T15:59:59Z");
const AFTER_MIDNIGHT = new Date("2026-11-02T16:00:00Z");

describe("claimDueCheck", () => {
  it("fires once per session and Singapore day", () => {
    const storage = fakeStorage();
    const memory = newDueCheckMemory();

    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, memory)).toBe(true);
    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, memory)).toBe(false);
    expect(storage.map.get(DUE_CHECK_STORAGE_KEY)).toBe("2026-11-02");
  });

  it("does not fire again from a fresh page load in the same session", () => {
    const storage = fakeStorage();
    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, newDueCheckMemory())).toBe(
      true,
    );
    // A reload keeps sessionStorage but loses the page's memory.
    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, newDueCheckMemory())).toBe(
      false,
    );
  });

  it("fires again when the Singapore day changes at 16:00 UTC", () => {
    const storage = fakeStorage();
    const memory = newDueCheckMemory();

    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, memory)).toBe(true);
    expect(claimDueCheck(AFTER_MIDNIGHT, storage, memory)).toBe(true);
    expect(storage.map.get(DUE_CHECK_STORAGE_KEY)).toBe("2026-11-03");
    expect(claimDueCheck(AFTER_MIDNIGHT, storage, memory)).toBe(false);
  });

  it("fires on the next day for a session that remembered an older day", () => {
    const storage = fakeStorage();
    storage.map.set(DUE_CHECK_STORAGE_KEY, "2026-11-01");
    expect(claimDueCheck(BEFORE_MIDNIGHT, storage, newDueCheckMemory())).toBe(
      true,
    );
  });

  it("does not treat 00:00 UTC as a new day", () => {
    const storage = fakeStorage();
    const memory = newDueCheckMemory();
    // 23:59 UTC on 1 Nov is 07:59 on 2 Nov in Singapore.
    expect(
      claimDueCheck(new Date("2026-11-01T23:59:00Z"), storage, memory),
    ).toBe(true);
    expect(storage.map.get(DUE_CHECK_STORAGE_KEY)).toBe("2026-11-02");
    // 00:30 UTC is 08:30 on the same Singapore day.
    expect(
      claimDueCheck(new Date("2026-11-02T00:30:00Z"), storage, memory),
    ).toBe(false);
  });

  it("falls back to once per page load when storage throws", () => {
    const memory = newDueCheckMemory();

    expect(claimDueCheck(BEFORE_MIDNIGHT, throwing(), memory)).toBe(true);
    expect(claimDueCheck(BEFORE_MIDNIGHT, throwing(), memory)).toBe(false);
    // Even a new day: the page was not reloaded.
    expect(claimDueCheck(AFTER_MIDNIGHT, throwing(), memory)).toBe(false);
  });

  it("falls back to once per page load when storage is unavailable", () => {
    const memory = newDueCheckMemory();
    expect(claimDueCheck(BEFORE_MIDNIGHT, null, memory)).toBe(true);
    expect(claimDueCheck(BEFORE_MIDNIGHT, null, memory)).toBe(false);
    // A new page load fires once more.
    expect(claimDueCheck(BEFORE_MIDNIGHT, null, newDueCheckMemory())).toBe(
      true,
    );
  });

  it("falls back when only the write throws", () => {
    const memory = newDueCheckMemory();
    const readOnly: DayStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(claimDueCheck(BEFORE_MIDNIGHT, readOnly, memory)).toBe(true);
    expect(claimDueCheck(BEFORE_MIDNIGHT, readOnly, memory)).toBe(false);
  });
});
