/// <reference types="vite/client" />
import { createFunctionHandle } from "convex/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { components, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

// The AuthKit client is constructed when auth.ts loads, and it reads these.
const requiredEnv = {
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  WORKOS_WEBHOOK_SECRET: "whsec_test",
};

/** Default WorkOS user payload values. */
const defaultUser = {
  object: "user",
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

/** Create a WorkOS user payload fixture. */
function makeUser(overrides: Partial<typeof defaultUser> = {}) {
  return { ...defaultUser, ...overrides };
}

/** Create a webhook event payload fixture. */
function makeEvent(event: string, user: ReturnType<typeof makeUser>) {
  return {
    id: `event_${event}`,
    createdAt: user.updatedAt,
    event,
    data: user,
  };
}

describe("authKitEvent", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key];
    }
  });

  test("user.updated before user.created fires the callback once as user.created", async () => {
    const t = initConvexTest();
    const onEventHandle = await t.run(async () =>
      createFunctionHandle(internal.auth.authKitEvent)
    );
    const user = makeUser();

    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: makeEvent("user.updated", user),
      onEventHandle,
    });
    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: makeEvent("user.created", user),
      onEventHandle,
    });

    const appUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(appUsers).toHaveLength(1);
    expect(appUsers[0].authId).toBe(user.id);
  });

  test("events for a deleted user do not reach the callback", async () => {
    const t = initConvexTest();
    const onEventHandle = await t.run(async () =>
      createFunctionHandle(internal.auth.authKitEvent)
    );
    const user = makeUser();

    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: makeEvent("user.deleted", user),
      onEventHandle,
    });
    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: makeEvent("user.created", user),
      onEventHandle,
    });

    const appUsers = await t.run(async (ctx) => {
      return ctx.db.query("users").collect();
    });
    expect(appUsers).toHaveLength(0);
  });
});
