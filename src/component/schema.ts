import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({
    eventId: v.string(),
    event: v.string(),
    updatedAt: v.optional(v.string()),
  }).index("eventId", ["eventId"]),
  users: defineTable({
    id: v.string(),
    email: v.string(),
    firstName: v.optional(v.union(v.null(), v.string())),
    lastName: v.optional(v.union(v.null(), v.string())),
    emailVerified: v.boolean(),
    profilePictureUrl: v.optional(v.union(v.null(), v.string())),
    lastSignInAt: v.optional(v.union(v.null(), v.string())),
    externalId: v.optional(v.union(v.null(), v.string())),
    metadata: v.record(v.string(), v.any()),
    locale: v.optional(v.union(v.null(), v.string())),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("id", ["id"]),
  // Sync state for manual backfill
  syncState: defineTable({
    key: v.literal("lastCheckpointedEventId"),
    value: v.string(),
  }).index("key", ["key"]),
});
