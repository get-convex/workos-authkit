/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, test, expect } from "vitest";
import { modules } from "./setup.test.js";
import schema from "./schema.js";
import workpool from "@convex-dev/workpool/test";
import workflow from "@convex-dev/workflow/test";
import { api } from "./_generated/api.js";

/** Default test user values. */
const defaultUser = {
  id: "user_01ABC",
  email: "alice@example.com",
  name: "Alice Smith" as string | null,
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

/** Create a webhook event payload fixture. */
function makeEvent(
  event: string,
  user: ReturnType<typeof makeUser>,
  overrides: Partial<{ id: string; createdAt: string }> = {}
) {
  return {
    id: overrides.id ?? `event_${event}`,
    createdAt: overrides.createdAt ?? user.updatedAt,
    event,
    data: { object: "user", ...user },
  };
}

/** Initialize a convex-test instance with sub-component registrations. */
function initConvexTest() {
  const t = convexTest(schema, modules);
  workflow.register(t, "backfillWorkflow");
  return t;
}

describe("onWebhookEvent", () => {
  test("user.created inserts the user", async () => {
    const t = initConvexTest();
    const user = makeUser();

    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.created", user),
    });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
    expect(dbUsers[0].id).toBe(user.id);
    expect(dbUsers[0].email).toBe(user.email);
  });

  test("user.updated patches the user from the delivered payload", async () => {
    const t = initConvexTest();
    const user = makeUser();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", user);
    });

    const updated = makeUser({
      name: "Alice Jones",
      lastName: "Jones",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.updated", updated),
    });

    const dbUser = await t.run(async (ctx) => {
      return ctx.db.query("users").unique();
    });
    expect(dbUser?.name).toBe("Alice Jones");
    expect(dbUser?.updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  test("user.deleted removes the user from the delivered payload", async () => {
    const t = initConvexTest();
    const user = makeUser();
    await t.run(async (ctx) => {
      await ctx.db.insert("users", user);
    });

    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.deleted", user),
    });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(0);
  });

  test("retried deliveries dedupe on eventId", async () => {
    const t = initConvexTest();
    const user = makeUser();
    const event = makeEvent("user.created", user);

    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event,
    });
    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event,
    });

    const { dbUsers, dbEvents } = await t.run(async (ctx) => {
      return {
        dbUsers: await ctx.db.query("users").collect(),
        dbEvents: await ctx.db.query("events").collect(),
      };
    });
    expect(dbUsers).toHaveLength(1);
    expect(dbEvents).toHaveLength(1);
  });

  test("user.updated delivered before user.created upserts the user", async () => {
    const t = initConvexTest();
    const created = makeUser();
    const updated = makeUser({
      name: "Alice Jones",
      lastName: "Jones",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });

    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.updated", updated),
    });
    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.created", created),
    });

    const dbUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(dbUsers).toHaveLength(1);
    expect(dbUsers[0].name).toBe("Alice Jones");
    expect(dbUsers[0].updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  test("stale user.updated deliveries are skipped", async () => {
    const t = initConvexTest();
    const user = makeUser({
      name: "Alice Jones",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("users", user);
    });

    const stale = makeUser({
      name: "Alice Smith",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    await t.mutation(api.lib.onWebhookEvent, {
      apiKey: "sk_test_123",
      event: makeEvent("user.updated", stale),
    });

    const dbUser = await t.run(async (ctx) => {
      return ctx.db.query("users").unique();
    });
    expect(dbUser?.name).toBe("Alice Jones");
    expect(dbUser?.updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });
});
