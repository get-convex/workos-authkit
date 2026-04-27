import { query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import type { DataModel } from "./_generated/dataModel";

const authFunctions: AuthFunctions = internal.auth;

export const authKit = new AuthKit<DataModel>(components.workOSAuthKit, {
  authFunctions,
  additionalEventTypes: ["session.created"],
});

export const { authKitAction } = authKit.actions({
  // Optionally implement logic to allow/deny user registration
  userRegistration: async (_ctx, action, response) => {
    if (action.userData.email.endsWith("@gmail.com")) {
      return response.deny("Gmail accounts are not allowed");
    }
    return response.allow();
  },
  // Optionally implement logic to allow/deny authentication
  authentication: async (_ctx, _action, response) => {
    return response.allow();
  },
});

export const { authKitEvent } = authKit.events({
  "user.created": async (ctx, event) => {
    await ctx.db.insert("users", {
      authId: event.data.id,
      email: event.data.email,
      name: `${event.data.firstName} ${event.data.lastName}`,
    });
  },
  "user.updated": async (ctx, event) => {
    const user = await ctx.db
      .query("users")
      .withIndex("authId", (q) => q.eq("authId", event.data.id))
      .unique();
    if (!user) {
      console.warn(`User not found: ${event.data.id}`);
      return;
    }
    await ctx.db.patch("users", user._id, {
      email: event.data.email,
      name: `${event.data.firstName} ${event.data.lastName}`,
    });
  },
  "user.deleted": async (ctx, event) => {
    const user = await ctx.db
      .query("users")
      .withIndex("authId", (q) => q.eq("authId", event.data.id))
      .unique();
    if (!user) {
      console.warn(`User not found: ${event.data.id}`);
      return;
    }
    await ctx.db.delete("users", user._id);
  },

  // Handle any event type
  "session.created": async (ctx, event) => {
    console.log("onCreateSession", event);
  },
});

export const { backfillUsers } = authKit.utils();

export const getCurrentUser = query({
  args: {},
  handler: async (ctx, _args) => {
    const user = await authKit.getAuthUser(ctx);
    return user;
  },
});
