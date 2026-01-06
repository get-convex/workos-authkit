import { Workpool } from "@convex-dev/workpool";
import { WorkOS, type Event as WorkOSEvent } from "@workos-inc/node";
import { omit, withoutSystemFields } from "convex-helpers";
import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
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
    do {
      const { data, listMetadata } = await workos.events.listEvents({
        events: eventTypes,
        after: nextCursor,
      });
      for (const event of data) {
        await ctx.runMutation(internal.lib.processEvent, {
          event,
          logLevel: args.logLevel,
          onEventHandle: args.onEventHandle,
        });
      }
      nextCursor = listMetadata.after;
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

// Get the last verified eventId with _creationTime (for efficient range queries)
export const getLastCheckpointedEvent = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      eventId: v.string(),
      _creationTime: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx) => {
    const state = await ctx.db
      .query("syncState")
      .withIndex("key", (q) => q.eq("key", "lastCheckpointedEventId"))
      .unique();

    if (!state) {
      return null;
    }

    const event = await ctx.db
      .query("events")
      .withIndex("eventId", (q) => q.eq("eventId", state.value))
      .unique();

    if (!event) {
      return null;
    }

    return {
      eventId: event.eventId,
      _creationTime: event._creationTime,
    };
  },
});

// Given a list of event IDs, return which ones are missing from the events table
// Uses `after` to limit query range (by induction, events before `after` exist)
export const getMissingEventIds = internalQuery({
  args: {
    eventIds: v.array(v.string()),
    after: v.optional(v.number()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { eventIds, after }) => {
    const existingEventIds = new Set<string>();

    const events = await ctx.db
      .query("events")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", after ?? 0))
      .order("asc");

    // Collect all existing event IDs that were created after `after`
    for await (const event of events) {
      existingEventIds.add(event.eventId);
    }

    // Return IDs from input that are NOT in the existing set
    return eventIds.filter((id) => !existingEventIds.has(id));
  },
});

// Update last verified event ID after successful backfill
export const updateLastCheckpointedEventId = internalMutation({
  args: {
    eventId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("syncState")
      .withIndex("key", (q) => q.eq("key", "lastCheckpointedEventId"))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { value: args.eventId });
    } else {
      await ctx.db.insert("syncState", {
        key: "lastCheckpointedEventId",
        value: args.eventId,
      });
    }

    return null;
  },
});

// Manual backfill: fetch all events after lastVerifiedEventId and process missing ones
export const backfillEvents = internalAction({
  args: {
    apiKey: v.string(),
    onEventHandle: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  returns: v.object({
    processed: v.number(),
    skipped: v.number(),
    lastEventId: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    processed: number;
    skipped: number;
    lastEventId: string | null;
  }> => {
    const workos = new WorkOS(args.apiKey);

    // Get last checkpointed event (contains eventId and _creationTime)
    const lastCheckpointedEvent = await ctx.runQuery(
      internal.lib.getLastCheckpointedEvent
    );
    const lastVerifiedEventId = lastCheckpointedEvent?.eventId ?? null;
    const lastVerifiedCreationTime = lastCheckpointedEvent?._creationTime ?? 0;

    const eventTypes = [
      "user.created" as const,
      "user.updated" as const,
      "user.deleted" as const,
      ...((args.eventTypes as WorkOSEvent["event"][]) ?? []),
    ];

    if (args.logLevel === "DEBUG") {
      console.log(
        `Starting backfill, lastVerifiedEventId: ${lastVerifiedEventId ?? "none (full scan)"}`
      );
      console.log("Event types:", eventTypes);
    }

    let nextCursor = lastVerifiedEventId ?? undefined;
    let lastEventId: string | null = null;
    let processed = 0;
    let skipped = 0;

    // Fetch events (always run at least once to check for new events)
    while (true) {
      const { data, listMetadata } = await workos.events.listEvents({
        events: eventTypes,
        after: nextCursor,
      });

      // No more events to process
      if (data.length === 0) {
        break;
      }

      // Batch check which events are missing (single query instead of one per event)
      // By induction, all events before lastVerifiedCreationTime are already processed
      const eventIds = data.map((e) => e.id);
      const missingEventIdsArray: string[] = await ctx.runQuery(
        internal.lib.getMissingEventIds,
        {
          eventIds,
          after: lastVerifiedCreationTime,
        }
      );
      const missingEventIds = new Set(missingEventIdsArray);

      if (args.logLevel === "DEBUG") {
        console.log(
          `Batch: ${data.length} events, ${missingEventIds.size} missing`
        );
      }

      // Process each event sequentially (only missing ones)
      for (const event of data) {
        if (!missingEventIds.has(event.id)) {
          skipped++;
          lastEventId = event.id;
          continue;
        }

        // Only process missing events
        await ctx.runMutation(internal.lib.processEvent, {
          event,
          logLevel: args.logLevel,
          onEventHandle: args.onEventHandle,
        });

        lastEventId = event.id;
        processed++;
      }

      // No more pages
      if (!listMetadata.after) {
        break;
      }
      nextCursor = listMetadata.after;
    }

    // Update checkpoint after all events are processed
    if (lastEventId) {
      await ctx.runMutation(internal.lib.updateLastCheckpointedEventId, {
        eventId: lastEventId,
      });
    }

    if (args.logLevel === "DEBUG") {
      console.log(
        `Backfill complete. Processed: ${processed}, Skipped: ${skipped}, Last event: ${lastEventId}`
      );
    }

    return { processed, skipped, lastEventId };
  },
});
