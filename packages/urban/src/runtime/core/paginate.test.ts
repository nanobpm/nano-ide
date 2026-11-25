import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySearchPageInfo, paginate, type SearchPage, type SearchPageRequest } from "./host.ts";

type Query = { readonly filter?: { readonly x?: number }; readonly page?: SearchPageRequest };

/** A fake paged search over `data`, honouring `limit` and an `after` cursor (the item index). */
function pagedSearch(data: readonly number[], seen: Query[]) {
  return async (query: Query): Promise<SearchPage<number>> => {
    seen.push(query);
    const page = query.page;
    const limit = page && "limit" in page && page.limit !== undefined ? page.limit : 2;
    const start = page && "after" in page && page.after !== undefined ? Number(page.after) + 1 : 0;
    const items = data.slice(start, start + limit);
    const last = start + items.length - 1;
    return {
      items,
      page: {
        totalItems: data.length,
        hasMoreTotalItems: false,
        startCursor: items.length ? String(start) : null,
        endCursor: items.length ? String(last) : null,
      },
    };
  };
}

test("paginate follows endCursor until exhausted, keeping the filter and limit (#630)", async () => {
  const seen: Query[] = [];
  const out: number[] = [];
  for await (const n of paginate(pagedSearch([1, 2, 3, 4, 5], seen), {
    filter: { x: 1 },
    page: { limit: 2 },
  })) {
    out.push(n);
  }
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [
    { filter: { x: 1 }, page: { limit: 2 } },
    { filter: { x: 1 }, page: { after: "1", limit: 2 } },
    { filter: { x: 1 }, page: { after: "3", limit: 2 } },
    { filter: { x: 1 }, page: { after: "4", limit: 2 } },
  ]);
});

test("paginate stops on a null endCursor and on a non-advancing cursor", async () => {
  const one: number[] = [];
  for await (const n of paginate(
    async () => ({ items: [7], page: emptySearchPageInfo() }),
    {},
  )) {
    one.push(n);
  }
  assert.deepEqual(one, [7]);

  let calls = 0;
  const stuck: number[] = [];
  for await (const n of paginate(
    async (): Promise<SearchPage<number>> => {
      calls++;
      return { items: [1], page: { ...emptySearchPageInfo(), endCursor: "same" } };
    },
    {},
  )) {
    stuck.push(n);
  }
  assert.equal(calls, 2, "a repeated cursor ends the iteration instead of looping forever");
  assert.deepEqual(stuck, [1, 1]);
});

test("paginate continues past a page whose rows were all dropped by the mapper (cursor still set)", async () => {
  // A page of only malformed rows maps to `items: []` but still carries a valid endCursor;
  // stopping on an empty mapped page would silently truncate every later page.
  const pages: Record<string, SearchPage<number>> = {
    start: { items: [], page: { ...emptySearchPageInfo(), endCursor: "c1" } },
    c1: { items: [9], page: { ...emptySearchPageInfo(), endCursor: null } },
  };
  const out: number[] = [];
  for await (const n of paginate(
    async (q: Query) => pages[q.page && "after" in q.page && q.page.after !== undefined ? q.page.after : "start"],
    {},
  )) {
    out.push(n);
  }
  assert.deepEqual(out, [9]);
});
