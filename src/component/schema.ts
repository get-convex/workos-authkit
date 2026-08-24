import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vUser } from "../validators.js";

export default defineSchema({
  events: defineTable({
    eventId: v.string(),
    event: v.string(),
    updatedAt: v.optional(v.string()),
  }).index("eventId", ["eventId"]),
  backfillState: defineTable({
    apiKey: v.string(),
  }),
  users: defineTable(vUser)
    .index("id", ["id"])
    .index("externalId", ["externalId"]),
});
