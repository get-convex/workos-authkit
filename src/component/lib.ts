import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { omit, withoutSystemFields } from "convex-helpers";
import { WorkOS, type Event as WorkOSEvent } from "@workos-inc/node";
import type { FunctionHandle } from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import schema from "./schema.js";

const eventWorkpool = new Workpool(components.eventWorkpool, {
  maxParallelism: 1,
});

export const enqueueWebhookEvent = mutation({
  args: {
    apiKey: v.string(),
    eventId: v.string(),
    event: v.string(),
    updatedAt: v.optional(v.string()),
    onEventHandle: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  handler: async (ctx, args) => {
    await eventWorkpool.cancelAll(ctx);
    await eventWorkpool.enqueueAction(ctx, internal.lib.updateEvents, {
      apiKey: args.apiKey,
      onEventHandle: args.onEventHandle,
      eventTypes: args.eventTypes,
      logLevel: args.logLevel,
    });
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
          event,
          logLevel: args.logLevel,
          onEventHandle: args.onEventHandle,
        });
      }
      nextCursor = listMetadata.after;
      rangeStart = undefined;
    } while (nextCursor);
  },
});

export const processEvent = internalMutation({
  args: {
    event: v.object({
      id: v.string(),
      createdAt: v.string(),
      event: v.string(),
      data: v.record(v.string(), v.any()),
      context: v.optional(v.record(v.string(), v.any())),
    }),
    logLevel: v.optional(v.literal("DEBUG")),
    onEventHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.logLevel === "DEBUG") {
      console.log("processing event", args.event);
    }
    const dbEvent = await ctx.db
      .query("events")
      .withIndex("eventId", (q) => q.eq("eventId", args.event.id))
      .unique();
    if (dbEvent) {
      console.log("event already processed", args.event.id);
      return;
    }
    await ctx.db.insert("events", {
      eventId: args.event.id,
      event: args.event.event,
      updatedAt: args.event.data.updatedAt,
    });
    const event = args.event as WorkOSEvent;
    switch (event.event) {
      case "user.created": {
        const data = omit(event.data, ["object"]);
        const existingUser = await ctx.db
          .query("users")
          .withIndex("id", (q) => q.eq("id", data.id))
          .unique();
        if (existingUser) {
          console.warn("user already exists", data.id);
          break;
        }
        await ctx.db.insert("users", data);
        break;
      }
      case "user.updated": {
        const data = omit(event.data, ["object"]);
        const user = await ctx.db
          .query("users")
          .withIndex("id", (q) => q.eq("id", data.id))
          .unique();
        if (!user) {
          console.error("user not found", data.id);
          break;
        }
        if (user.updatedAt >= data.updatedAt) {
          console.warn(`user already updated for event ${event.id}, skipping`);
          break;
        }
        await ctx.db.patch(user._id, data);
        break;
      }
      case "user.deleted": {
        const data = omit(event.data, ["object"]);
        const user = await ctx.db
          .query("users")
          .withIndex("id", (q) => q.eq("id", data.id))
          .unique();
        if (!user) {
          console.warn("user not found", data.id);
          break;
        }
        await ctx.db.delete(user._id);
        break;
      }
    }
    if (args.onEventHandle) {
      await ctx.runMutation(args.onEventHandle as FunctionHandle<"mutation">, {
        event: args.event.event,
        data: args.event.data,
      });
    }
  },
});

export const getAuthUser = query({
  args: {
    id: v.string(),
  },
  returns: v.union(schema.tables.users.validator, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return user ? withoutSystemFields(user) : null;
  },
});
