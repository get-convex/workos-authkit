import { v } from "convex/values";

export const vUser = v.object({
  id: v.string(),
  email: v.string(),
  name: v.optional(v.union(v.null(), v.string())),
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
});
