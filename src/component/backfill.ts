import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { WorkOS } from "@workos-inc/node";
import type { FunctionHandle } from "convex/server";
import { WorkflowManager } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import schema from "./schema.js";

const workflow = new WorkflowManager(components.backfillWorkflow, {
  workpoolOptions: { maxParallelism: 1 },
});

const vUser = schema.tables.users.validator;

export const getBackfillApiKey = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const backfillState = await ctx.db.query("backfillState").unique();
    return backfillState?.apiKey ?? null;
  },
});

export const fetchUsersPage = internalAction({
  args: {
    after: v.optional(v.string()),
  },
  returns: v.object({
    users: v.array(vUser),
    nextCursor: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    users: Array<typeof vUser.type>;
    nextCursor: string | undefined;
  }> => {
    const apiKey: string | null = await ctx.runQuery(
      internal.backfill.getBackfillApiKey,
      {}
    );
    if (!apiKey) {
      throw new Error("Backfill API key not found");
    }
    const workos = new WorkOS(apiKey);
    const { data, listMetadata } = await workos.userManagement.listUsers({
      limit: 100,
      after: args.after,
      order: "asc",
    });
    return {
      users: data.map(({ object: _object, ...rest }) => rest),
      nextCursor: listMetadata.after ?? undefined,
    };
  },
});

export const upsertUsersPage = internalMutation({
  args: {
    users: v.array(vUser),
    onEventHandle: v.optional(v.string()),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingUsers = await Promise.all(
      args.users.map((user) =>
        ctx.db
          .query("users")
          .withIndex("id", (q) => q.eq("id", user.id))
          .unique()
      )
    );

    const newUsers = args.users.filter((_, i) => !existingUsers[i]);

    if (args.logLevel === "DEBUG") {
      console.log(
        `backfill: ${newUsers.length} new users out of ${args.users.length}`
      );
    }

    for (const user of newUsers) {
      await ctx.db.insert("users", user);

      if (args.onEventHandle) {
        await ctx.runMutation(
          args.onEventHandle as FunctionHandle<"mutation">,
          { event: "user.created", data: { ...user, object: "user" } }
        );
      }
    }
    return null;
  },
});

const MAX_PAGES_PER_BATCH = 50;

export const backfillBatch = workflow.define({
  args: {
    onEventHandle: v.optional(v.string()),
    logLevel: v.optional(v.literal("DEBUG")),
    after: v.optional(v.string()),
  },
  returns: v.object({
    done: v.boolean(),
    cursor: v.optional(v.string()),
  }),
  handler: async (step, args): Promise<{ done: boolean; cursor?: string }> => {
    let cursor = args.after;
    let pagesProcessed = 0;

    while (pagesProcessed < MAX_PAGES_PER_BATCH) {
      const result = await step.runAction(internal.backfill.fetchUsersPage, {
        after: cursor,
      });

      if (result.users.length > 0) {
        await step.runMutation(internal.backfill.upsertUsersPage, {
          users: result.users,
          onEventHandle: args.onEventHandle,
          logLevel: args.logLevel,
        });
      }

      cursor = result.nextCursor;
      pagesProcessed++;
      if (!cursor) {
        return { done: true };
      }
    }

    return { done: false, cursor };
  },
});

export const backfillOnComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({
      onEventHandle: v.optional(v.string()),
      logLevel: v.optional(v.literal("DEBUG")),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind !== "success") {
      console.error(`Backfill workflow ${args.result.kind}`, args.result);
      const backfillState = await ctx.db.query("backfillState").unique();
      if (backfillState) {
        await ctx.db.delete(backfillState._id);
      }
      return null;
    }
    const returnValue = args.result.returnValue as {
      done: boolean;
      cursor?: string;
    };
    if (returnValue.done || !returnValue.cursor) {
      const backfillState = await ctx.db.query("backfillState").unique();
      if (backfillState) {
        await ctx.db.delete(backfillState._id);
      }
    } else {
      await workflow.start(
        ctx,
        internal.backfill.backfillBatch,
        {
          ...args.context,
          after: returnValue.cursor,
        },
        {
          onComplete: internal.backfill.backfillOnComplete,
          context: args.context,
        }
      );
    }
    return null;
  },
});

export const startBackfill = mutation({
  args: {
    apiKey: v.string(),
    onEventHandle: v.optional(v.string()),
    logLevel: v.optional(v.literal("DEBUG")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("backfillState").unique();
    if (existing) {
      console.warn("Backfill already in progress, skipping");
      return null;
    }
    await ctx.db.insert("backfillState", { apiKey: args.apiKey });
    const context = {
      onEventHandle: args.onEventHandle,
      logLevel: args.logLevel,
    };
    await workflow.start(ctx, internal.backfill.backfillBatch, context, {
      onComplete: internal.backfill.backfillOnComplete,
      context,
    });
    return null;
  },
});
