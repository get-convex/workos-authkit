/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
import { modules } from "./setup.test.js";
import schema from "./schema.js";
import workpool from "@convex-dev/workpool/test";
import workflow from "@convex-dev/workflow/test";
import { api, internal } from "./_generated/api.js";

vi.mock("@workos-inc/node", () => {
  return {
    WorkOS: vi.fn().mockImplementation(function () {
      return {
        userManagement: {
          listUsers: vi.fn(),
        },
      };
    }),
  };
});

/** Default test user values. */
const defaultUser = {
  id: "user_01ABC",
  email: "alice@example.com",
  firstName: "Alice" as string | null,
  lastName: "Smith" as string | null,
  emailVerified: true,
  profilePictureUrl: null as string | null,
  lastSignInAt: null as string | null,
  externalId: null as string | null,
  metadata: {} as Record<string, string>,
  locale: null as string | null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/** Create a test user fixture. */
function makeUser(overrides: Partial<typeof defaultUser> = {}) {
  return { ...defaultUser, ...overrides };
}

/** Initialize a convex-test instance with sub-component registrations. */
function initConvexTest() {
  const t = convexTest(schema, modules);
  workpool.register(t, "eventWorkpool");
  workflow.register(t, "backfillWorkflow");
  return t;
}

describe("backfill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("processUsersPage fetches and inserts users, returns only cursor", async () => {
    const user = makeUser();
    const { WorkOS } = await import("@workos-inc/node");
    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: {
            listUsers: vi.fn().mockResolvedValue({
              data: [{ object: "user", ...user }],
              listMetadata: { after: null },
            }),
          },
        };
      }
    );

    const t = initConvexTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_test_123" });
    });
    const result = await t.action(internal.backfill.processUsersPage, {});

    expect(result).toEqual({ nextCursor: undefined });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
    expect(dbUsers[0].id).toBe(user.id);
  });

  test("processUsersPage passes order asc to listUsers", async () => {
    const { WorkOS } = await import("@workos-inc/node");
    const listUsersMock = vi.fn().mockResolvedValue({
      data: [],
      listMetadata: { after: null },
    });
    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: { listUsers: listUsersMock },
        };
      }
    );

    const t = initConvexTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_test_123" });
    });
    await t.action(internal.backfill.processUsersPage, {});

    expect(listUsersMock).toHaveBeenCalledWith({
      limit: 100,
      after: undefined,
      order: "asc",
    });
  });

  test("upsertUsersPage inserts new users", async () => {
    const t = initConvexTest();
    const users = [
      makeUser({ id: "user_01", email: "a@example.com" }),
      makeUser({ id: "user_02", email: "b@example.com" }),
    ];

    await t.mutation(internal.backfill.upsertUsersPage, { users });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(2);
    expect(dbUsers.map((u) => u.id).sort()).toEqual(["user_01", "user_02"]);
  });

  test("upsertUsersPage skips existing users (idempotency)", async () => {
    const t = initConvexTest();
    const user = makeUser({ id: "user_existing", email: "exists@example.com" });

    // Pre-insert the user
    await t.run(async (ctx) => {
      await ctx.db.insert("users", user);
    });

    // Upsert with the same user
    await t.mutation(internal.backfill.upsertUsersPage, { users: [user] });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
  });

  test("full workflow processes single page", async () => {
    const users = [
      makeUser({ id: "user_w1", email: "w1@example.com" }),
      makeUser({ id: "user_w2", email: "w2@example.com" }),
    ];

    const { WorkOS } = await import("@workos-inc/node");
    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: {
            listUsers: vi.fn().mockResolvedValue({
              data: users.map((u) => ({ object: "user", ...u })),
              listMetadata: { after: null },
            }),
          },
        };
      }
    );

    const t = initConvexTest();
    await t.mutation(api.backfill.startBackfill, {
      apiKey: "sk_test_123",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(2);
    expect(dbUsers.map((u) => u.id).sort()).toEqual(["user_w1", "user_w2"]);

    // Verify backfillState is cleaned up
    const backfillState = await t.run(async (ctx) => {
      return ctx.db.query("backfillState").unique();
    });
    expect(backfillState).toBeNull();
  });

  test("processUsersPage returns cursor for pagination", async () => {
    const user = makeUser({ id: "user_p1", email: "p1@example.com" });

    const { WorkOS } = await import("@workos-inc/node");
    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: {
            listUsers: vi.fn().mockResolvedValue({
              data: [{ object: "user", ...user }],
              listMetadata: { after: "cursor_abc" },
            }),
          },
        };
      }
    );

    const t = initConvexTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_test_123" });
    });
    const result = await t.action(internal.backfill.processUsersPage, {});

    expect(result).toEqual({ nextCursor: "cursor_abc" });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
    expect(dbUsers[0].id).toBe(user.id);
  });

  test("pagination data flows through processUsersPage", async () => {
    const page1Users = [
      makeUser({ id: "user_p1", email: "p1@example.com" }),
    ];
    const page2Users = [
      makeUser({ id: "user_p2", email: "p2@example.com" }),
    ];

    const { WorkOS } = await import("@workos-inc/node");
    const listUsersMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: page1Users.map((u) => ({ object: "user", ...u })),
        listMetadata: { after: "cursor_abc" },
      })
      .mockResolvedValueOnce({
        data: page2Users.map((u) => ({ object: "user", ...u })),
        listMetadata: { after: null },
      });

    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: { listUsers: listUsersMock },
        };
      }
    );

    const t = initConvexTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_test_123" });
    });

    const page1 = await t.action(internal.backfill.processUsersPage, {});
    expect(page1.nextCursor).toBe("cursor_abc");

    const page2 = await t.action(internal.backfill.processUsersPage, {
      after: page1.nextCursor,
    });
    expect(page2.nextCursor).toBeUndefined();

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(2);
    expect(dbUsers.map((u) => u.id).sort()).toEqual(["user_p1", "user_p2"]);
  });

  test("startBackfill skips when backfill already in progress", async () => {
    const t = initConvexTest();

    // Pre-insert a backfillState row to simulate an in-progress backfill
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_existing" });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.mutation(api.backfill.startBackfill, {
      apiKey: "sk_test_123",
    });

    // Should have warned about skipping
    expect(warnSpy).toHaveBeenCalledWith(
      "Backfill already in progress, skipping"
    );

    // Original key should remain unchanged
    const state = await t.run(async (ctx) => {
      return ctx.db.query("backfillState").unique();
    });
    expect(state?.apiKey).toBe("sk_existing");

    warnSpy.mockRestore();
  });

  test("upsert is idempotent after processUsersPage inserts", async () => {
    const users = [
      makeUser({ id: "user_idem", email: "idem@example.com" }),
    ];

    const { WorkOS } = await import("@workos-inc/node");
    (WorkOS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () {
        return {
          userManagement: {
            listUsers: vi.fn().mockResolvedValue({
              data: users.map((u) => ({ object: "user", ...u })),
              listMetadata: { after: null },
            }),
          },
        };
      }
    );

    const t = initConvexTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("backfillState", { apiKey: "sk_test_123" });
    });

    // Insert users via processUsersPage (the actual insertion path)
    await t.action(internal.backfill.processUsersPage, {});

    // Re-upsert the same users directly
    await t.mutation(internal.backfill.upsertUsersPage, { users });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
  });
});
