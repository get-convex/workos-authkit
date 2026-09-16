import { type Event as WorkOSEvent } from "@workos-inc/node";
import { withoutSystemFields } from "convex-helpers";
import { parse } from "convex-helpers/validators";
import type { FunctionHandle } from "convex/server";
import { type Infer, v } from "convex/values";
import { vUser } from "../validators.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";

export const vEvent = v.object({
  id: v.string(),
  createdAt: v.string(),
  event: v.string(),
  data: v.record(v.string(), v.any()),
  context: v.optional(v.record(v.string(), v.any())),
});

/**
 * Returns the WorkOS user id an event is about, or undefined when the
 * event is about something other than a user.
 */
function eventUserId(event: Infer<typeof vEvent>): string | undefined {
  const data = event.data as { id?: unknown; userId?: unknown };
  if (typeof data.userId === "string") {
    return data.userId;
  }
  const isUserEvent =
    event.event === "user.created" ||
    event.event === "user.updated" ||
    event.event === "user.deleted";
  if (isUserEvent && typeof data.id === "string") {
    return data.id;
  }
  return undefined;
}

async function processEventHandler(
  ctx: MutationCtx,
  args: {
    event: Infer<typeof vEvent>;
    logLevel?: "DEBUG";
    onEventHandle?: string;
  }
) {
  if (args.logLevel === "DEBUG") {
    console.log("processing event", args.event);
  }
  const event = args.event as WorkOSEvent;
  const userId = eventUserId(args.event);
  const dbEvent = await ctx.db
    .query("events")
    .withIndex("eventId", (q) => q.eq("eventId", args.event.id))
    .unique();
  if (dbEvent) {
    console.log("event already processed", args.event.id);
    return;
  }
  await ctx.db.insert("events", {
    userId,
    eventId: args.event.id,
    event: args.event.event,
    updatedAt: args.event.data.updatedAt as string | undefined,
  });
  let eventForCallback = event.event;
  let dataForCallback = args.event.data;
  switch (event.event) {
    case "user.created":
    case "user.updated": {
      const data = parse(vUser, event.data);
      const existingUser = await ctx.db
        .query("users")
        .withIndex("id", (q) => q.eq("id", data.id))
        .unique();
      if (!existingUser) {
        const deletedUser = await ctx.db
          .query("deletedUsers")
          .withIndex("id", (q) => q.eq("id", data.id))
          .unique();
        if (deletedUser) {
          console.warn("user already deleted, skipping", event.event, data.id);
          return;
        }
        await ctx.db.insert("users", data);
        if (event.event === "user.updated") {
          // WorkOS can deliver the update before the create. The update
          // payload holds the whole user, so it is safe to insert.
          console.warn("user not found for update, inserting", data.id);
          eventForCallback = "user.created";
        }
      } else {
        if (event.event === "user.created") {
          console.warn("user already exists", data.id);
          // The callback already fired as user.created when this user was
          // first inserted, so skip it here.
          return;
        } else if (existingUser.updatedAt >= data.updatedAt) {
          console.warn(`user already updated for event ${event.id}, skipping`);
          return;
        }
        await ctx.db.patch("users", existingUser._id, data);
      }
      break;
    }
    case "user.deleted": {
      // Only the id is needed, so a trimmed payload should not fail the webhook.
      const { id } = parse(v.object({ id: v.string() }), event.data);
      // Record the deletion even if the user was never inserted locally, so a
      // late user.created or user.updated for this user is skipped.
      const deletedUser = await ctx.db
        .query("deletedUsers")
        .withIndex("id", (q) => q.eq("id", id))
        .unique();
      if (!deletedUser) {
        await ctx.db.insert("deletedUsers", { id });
      }
      const user = await ctx.db
        .query("users")
        .withIndex("id", (q) => q.eq("id", id))
        .unique();
      if (!user) {
        console.warn("user not found, skipping deletion", id);
        return;
      }
      await ctx.db.delete("users", user._id);
      // The callback data is typed as a whole user, so fill anything the
      // payload left out from the stored user.
      dataForCallback = {
        ...withoutSystemFields(user),
        object: "user",
        ...args.event.data,
      };
      break;
    }
  }
  if (args.onEventHandle) {
    await ctx.runMutation(args.onEventHandle as FunctionHandle<"mutation">, {
      event: eventForCallback,
      data: dataForCallback,
    });
  }
}

export const onWebhookEvent = mutation({
  args: {
    event: vEvent,
    onEventHandle: v.optional(v.string()),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // The payload is signature-verified and dedupes on eventId, so all
    // event types can be processed inline.
    await processEventHandler(ctx, args);
    return null;
  },
});

export const getAuthUser = query({
  args: {
    id: v.string(),
  },
  returns: v.union(vUser, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return publicUser(user);
  },
});

export const getAuthUserByExternalId = query({
  args: {
    externalId: v.string(),
  },
  returns: v.union(vUser, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("externalId", (q) => q.eq("externalId", args.externalId))
      .unique();
    return publicUser(user);
  },
});

/** Drops the Convex system fields so the user matches the public vUser shape. */
function publicUser(user: Doc<"users"> | null): Infer<typeof vUser> | null {
  if (!user) {
    return null;
  }
  return withoutSystemFields(user);
}
