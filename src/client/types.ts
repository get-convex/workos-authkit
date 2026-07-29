import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

// Type utils follow

export type QueryCtx = Pick<
  GenericQueryCtx<GenericDataModel>,
  "auth" | "runQuery" | "storage"
>;
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "auth" | "runQuery" | "runMutation"
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "auth" | "runQuery" | "runMutation" | "runAction" | "storage"
>;
