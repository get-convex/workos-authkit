import { type Infer, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { withoutSystemFields } from "convex-helpers";
import { WorkOS, type Event as WorkOSEvent } from "@workos-inc/node";
import type { FunctionHandle } from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import { vUser } from "../validators.js";
import { parse } from "convex-helpers/validators";
import type { Doc } from "./_generated/dataModel.js";

const eventWorkpool = new Workpool(components.eventWorkpool, {
  maxParallelism: 1,
});

export const vEvent = v.object({
  id: v.string(),
  createdAt: v.string(),
  event: v.string(),
  data: v.record(v.string(), v.any()),
  context: v.optional(v.record(v.string(), v.any())),
});

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
  const userId =
    "id" in args.event.data
      ? args.event.data.id
      : "userId" in args.event.data
        ? args.event.data.userId
        : undefined;
  const dbEvent = await ctx.db
    .query("events")
    .withIndex("eventId", (q) => q.eq("eventId", args.event.id))
    .unique();
  if (dbEvent) {
    console.log("event already processed", args.event.id);
    return;
  }
  await ctx.db.insert("events", {
    // can be used in the future to delete events related to a user
    userId,
    eventId: args.event.id,
    event: args.event.event,
    updatedAt: args.event.data.updatedAt as string | undefined,
  });
  let eventForCallback = event.event;
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
          // The update may have been delivered before the create; the
          // payload is the full user object, so insert it. The create
          // no-ops on arrival via the existing-user guard.
          console.warn("user not found for update, inserting", data.id);
          eventForCallback = "user.created";
        }
      } else {
        if (event.event === "user.created") {
          console.warn("user already exists", data.id);
          // Note: we skip notifying the user's callback here, but we
          // should have called them with "user.created" for the update.
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
      const data = parse(vUser, event.data);
      const user = await ctx.db
        .query("users")
        .withIndex("id", (q) => q.eq("id", data.id))
        .unique();
      if (!user) {
        console.warn("user not found, skipping deletion", data.id);
        return;
      }
      await ctx.db.delete("users", user._id);
      await ctx.db.insert("deletedUsers", {
        id: user.id,
      });
      break;
    }
  }
  if (args.onEventHandle) {
    await ctx.runMutation(args.onEventHandle as FunctionHandle<"mutation">, {
      event: eventForCallback,
      data: args.event.data,
    });
  }
}

export const onWebhookEvent = mutation({
  args: {
    apiKey: v.string(),
    event: vEvent,
    onEventHandle: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
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

export const getCursor = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const lastProcessedEvent = await ctx.db
      .query("events")
      .order("desc")
      .first();
    return lastProcessedEvent?.eventId;
  },
});

export const updateEvents = internalAction({
  args: {
    apiKey: v.string(),
    onEventHandle: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  handler: async (ctx, args) => {
    // Cancel other pending workpool jobs since this run will
    // process all available events from the WorkOS API.
    await eventWorkpool.cancelAll(ctx);
    const workos = new WorkOS(args.apiKey);
    const cursor = await ctx.runQuery(internal.lib.getCursor);
    let nextCursor = cursor ?? undefined;
    const eventTypes = [
      "user.created" as const,
      "user.updated" as const,
      "user.deleted" as const,
      ...((args.eventTypes as WorkOSEvent["event"][]) ?? []),
    ];
    // No cursor should mean we haven't handled any events - set
    // a start time of 5 minutes ago
    let rangeStart = nextCursor
      ? undefined
      : new Date(Date.now() - 1000 * 60 * 5).toISOString();
    do {
      const { data, listMetadata } = await workos.events.listEvents({
        events: eventTypes,
        after: nextCursor,
        rangeStart,
      });
      for (const event of data) {
        await ctx.runMutation(internal.lib.processEvent, {
          event: parse(vEvent, event),
          logLevel: args.logLevel,
          onEventHandle: args.onEventHandle,
        });
      }
      nextCursor = listMetadata.after ?? undefined;
      rangeStart = undefined;
    } while (nextCursor);
  },
});

export const processEvent = internalMutation({
  args: {
    event: vEvent,
    logLevel: v.optional(v.literal("DEBUG")),
    onEventHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await processEventHandler(ctx, args);
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

function publicUser(user: Doc<"users"> | null): Infer<typeof vUser> | null {
  if (!user) return null;
  return withoutSystemFields(user);
}
