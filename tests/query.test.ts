import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WebInkDatabase,
  setDatabaseForTesting,
} from "../src/background/database";
import { handleDataRequest } from "../src/background/data";
import { QueryTaskRegistry } from "../src/background/query";
import type { Annotation } from "../src/core/model";

const pageUrl = "https://example.test/query";
let db: WebInkDatabase;

function row(id: string, second: number): Annotation {
  const stamp = `2026-09-19T00:00:${String(second % 60).padStart(2, "0")}.000Z`;
  return {
    id,
    pageUrl,
    pageTitle: "Query",
    color: "#facc15",
    note: "searchable annotation",
    tags: ["query"],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: stamp,
    revision: 1,
    kind: "text",
    target: {
      exact: "query evidence",
      prefix: "",
      suffix: "",
      start: 0,
      end: 14,
      rootSelector: "main",
    },
  };
}

beforeEach(() => {
  db = new WebInkDatabase(`query-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
});

afterEach(async () => {
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
});

describe("query task ownership and bulk planner", () => {
  it("does not let an older same-ID task cleanup erase a newer task", () => {
    const tasks = new QueryTaskRegistry();
    const first = tasks.start("owner", "same");
    const second = tasks.start("owner", "same");
    expect(first.cancelled).toBe(true);
    tasks.complete("owner", "same", first);
    tasks.cancel("owner", "same");
    expect(second.cancelled).toBe(true);
  });

  it("keeps cancellation isolated to the caller owner and honors a bounded pre-cancel", async () => {
    await db.annotations.put(row("owner-row", 1));
    await handleDataRequest(
      { type: "annotations.query.cancel", requestId: "same-id" },
      { trusted: true, callerKey: "owner-a" },
    );
    expect(
      await handleDataRequest(
        { type: "annotations.query", query: { pageUrl, requestId: "same-id" } },
        { trusted: true, callerKey: "owner-b" },
      ),
    ).toMatchObject({
      ok: true,
      data: { items: [expect.objectContaining({ id: "owner-row" })] },
    });
    expect(
      await handleDataRequest(
        { type: "annotations.query", query: { pageUrl, requestId: "same-id" } },
        { trusted: true, callerKey: "owner-a" },
      ),
    ).toEqual({ ok: true, data: { items: [], cancelled: true } });
  });

  it("uses one <=51 native bulk read for a fully covered cursor query", async () => {
    await db.annotations.bulkPut(
      Array.from({ length: 100 }, (_, index) => row(`covered-${index}`, index)),
    );
    let reads = 0;
    const reading = <T>(value: T) => {
      reads += 1;
      return value;
    };
    db.annotations.hook("reading", reading);
    const result = await handleDataRequest(
      { type: "annotations.query", query: { pageUrl, limit: 50 } },
      { trusted: true, callerKey: "covered" },
    );
    db.annotations.hook("reading").unsubscribe(reading);
    expect(result).toMatchObject({
      ok: true,
      data: { items: expect.any(Array), nextCursor: expect.any(Object) },
    });
    expect(reads).toBeLessThanOrEqual(51);
  });

  it("stops residual scanning after cancellation observed in the second capped bulk batch", async () => {
    await db.annotations.bulkPut(
      Array.from({ length: 500 }, (_, index) =>
        row(`residual-${index}`, index),
      ),
    );
    let reads = 0;
    let cancellationSent = false;
    const owner = { trusted: true, callerKey: "residual-owner" };
    const reading = <T>(value: T) => {
      reads += 1;
      if (reads === 26 && !cancellationSent) {
        cancellationSent = true;
        void handleDataRequest(
          { type: "annotations.query.cancel", requestId: "residual" },
          owner,
        );
      }
      return value;
    };
    db.annotations.hook("reading", reading);
    const result = await handleDataRequest(
      {
        type: "annotations.query",
        query: {
          pageUrl,
          text: "no such substring",
          requestId: "residual",
          limit: 50,
        },
      },
      owner,
    );
    db.annotations.hook("reading").unsubscribe(reading);
    expect(result).toEqual({ ok: true, data: { items: [], cancelled: true } });
    expect(reads).toBeGreaterThanOrEqual(26);
    expect(reads).toBeLessThanOrEqual(25 + 128);
  });

  it.each([1_000])(
    "matches the DESC reference across %i mixed-metadata records",
    async (count) => {
      const records = Array.from({ length: count }, (_, index) => ({
        ...row(`mixed-${String(index).padStart(6, "0")}`, index),
        pageUrl: index % 3 === 0 ? "https://example.test/other" : pageUrl,
        color: index % 2 === 0 ? "#4ade80" : "#facc15",
        tags: index % 17 === 0 ? ["needle", "query"] : ["query"],
        note:
          index % 19 === 0 ? "searchable annotation exact" : "other annotation",
      }));
      await db.annotations.bulkPut(records);
      const expected = records
        .filter(
          (record) =>
            record.pageUrl === pageUrl &&
            record.kind === "text" &&
            record.color === "#4ade80" &&
            record.tags.includes("needle") &&
            `${record.note} ${record.target.exact}`
              .toLocaleLowerCase()
              .includes("searchable"),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.id.localeCompare(left.id),
        );
      const actual: Annotation[] = [];
      let cursor: { updatedAt: string; id: string } | undefined;
      do {
        const response = await handleDataRequest(
          {
            type: "annotations.query",
            query: {
              pageUrl,
              kind: "text",
              color: "#4ade80",
              tag: "needle",
              text: "searchable",
              limit: 50,
              ...(cursor ? { cursor } : {}),
            },
          },
          { trusted: true, callerKey: `reference-${count}` },
        );
        if (!response.ok) throw new Error(response.error);
        const page = response.data as {
          items: Annotation[];
          nextCursor?: { updatedAt: string; id: string };
        };
        actual.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(actual.map((record) => record.id)).toEqual(
        expected.map((record) => record.id),
      );
    },
    20_000,
  );
});
