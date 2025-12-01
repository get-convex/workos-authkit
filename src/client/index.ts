import {
  type AuthConfig,
  type FunctionReference,
  type GenericDataModel,
  type GenericMutationCtx,
  type HttpRouter,
  createFunctionHandle,
  httpActionGeneric,
  internalMutationGeneric,
} from "convex/server";
import type { RunQueryCtx } from "./types.js";
import {
  WorkOS,
  type Event as WorkOSEvent,
  type ActionContext as WorkOSActionContext,
  type UserRegistrationActionResponseData,
  type AuthenticationActionResponseData,
} from "@workos-inc/node";
import type { SetRequired } from "type-fest";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

type WorkOSResponsePayload =
  | AuthenticationActionResponseData
  | UserRegistrationActionResponseData;

type Options = {
  authFunctions?: AuthFunctions;
  clientId?: string;
  apiKey?: string;
  webhookSecret?: string;
  webhookPath?: string;
  additionalEventTypes?: WorkOSEvent["event"][];
  actionSecret?: string;
  logLevel?: "DEBUG";
};
type Config = SetRequired<Options, "clientId" | "apiKey" | "webhookSecret">;

export type AuthFunctions = {
  authKitAction?: FunctionReference<
    "mutation",
    "internal",
    { action: unknown },
    WorkOSResponsePayload
  >;
  authKitEvent?: FunctionReference<
    "mutation",
    "internal",
    { event: string; data: unknown },
    null
  >;
};

const requireEnvVar = (
  str: string | undefined,
  onUndefined: () => void
): string => {
  if (!str) {
    onUndefined();
  }
  return str!;
};

export class AuthKit<DataModel extends GenericDataModel> {
  public workos: WorkOS;
  private config: Config;
  constructor(
    public component: ComponentApi,
    public options?: Options
  ) {
    const missingEnvVars: string[] = [];
    const clientId = requireEnvVar(
      options?.clientId ?? process.env.WORKOS_CLIENT_ID,
      () => missingEnvVars.push("WORKOS_CLIENT_ID")
    );
    const apiKey = requireEnvVar(
      options?.apiKey ?? process.env.WORKOS_API_KEY,
      () => missingEnvVars.push("WORKOS_API_KEY")
    );
    const webhookSecret = requireEnvVar(
      options?.webhookSecret ?? process.env.WORKOS_WEBHOOK_SECRET,
      () => missingEnvVars.push("WORKOS_WEBHOOK_SECRET")
    );
    if (missingEnvVars.length > 0) {
      throw new Error(
        `Missing environment variables: ${missingEnvVars.join(", ")}`
      );
    }
    this.config = {
      ...(options ?? {}),
      clientId,
      apiKey,
      webhookSecret,
      actionSecret: options?.actionSecret ?? process.env.WORKOS_ACTION_SECRET,
      webhookPath: options?.webhookPath ?? "/workos/webhook",
    };
    this.workos = new WorkOS(this.config.apiKey);
  }

  getAuthConfigProviders = () =>
    [
      {
        type: "customJwt",
        issuer: `https://api.workos.com/`,
        algorithm: "RS256",
        jwks: `https://api.workos.com/sso/jwks/${this.config.clientId}`,
        applicationID: this.config.clientId,
      },
      {
        type: "customJwt",
        issuer: `https://api.workos.com/user_management/${this.config.clientId}`,
        algorithm: "RS256",
        jwks: `https://api.workos.com/sso/jwks/${this.config.clientId}`,
      },
    ] satisfies AuthConfig["providers"];

  async getAuthUser(ctx: RunQueryCtx) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    return ctx.runQuery(this.component.lib.getAuthUser, {
      id: identity.subject,
    });
  }
  events<K extends WorkOSEvent["event"]>(opts: {
    [Key in K]: <
      E extends Extract<
        WorkOSEvent,
        {
          event: Key;
        }
      >,
    >(
      ctx: GenericMutationCtx<DataModel>,
      event: E
    ) => Promise<void>;
  }) {
    return {
      authKitEvent: internalMutationGeneric({
        args: {
          event: v.string(),
          data: v.record(v.string(), v.any()),
        },
        returns: v.null(),
        handler: async (ctx, args) => {
          await opts[args.event as K](ctx, args as never);
        },
      }),
    };
  }
  actions<K extends "authentication" | "userRegistration">(opts: {
    [Key in K]: <
      A extends Extract<
        WorkOSActionContext,
        {
          object: Key extends "authentication"
            ? "authentication_action_context"
            : "user_registration_action_context";
        }
      >,
    >(
      ctx: GenericMutationCtx<DataModel>,
      action: A,
      {
        allow,
        deny,
      }: {
        allow: () => WorkOSResponsePayload;
        deny: (errorMessage: string) => WorkOSResponsePayload;
      }
    ) => Promise<WorkOSResponsePayload>;
  }) {
    return {
      authKitAction: internalMutationGeneric({
        args: {
          action: v.record(v.string(), v.any()),
        },
        returns: v.record(v.string(), v.any()),
        handler: async (ctx, args) => {
          const resp = {
            type:
              args.action.object === "authentication_action_context"
                ? ("authentication" as const)
                : ("user_registration" as const),
            timestamp: new Date().getTime(),
          };
          const allow = () => ({ ...resp, verdict: "Allow" as const });
          const deny = (errorMessage: string) => ({
            ...resp,
            verdict: "Deny" as const,
            errorMessage,
          });
          const responsePayload = await opts[
            (args.action.object === "authentication_action_context"
              ? "authentication"
              : "userRegistration") as K
          ](ctx, args.action as never, {
            allow,
            deny,
          });
          return responsePayload;
        },
      }),
    };
  }
  registerRoutes(http: HttpRouter) {
    http.route({
      path: "/workos/webhook",
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const payload = await request.text();
        const sigHeader = request.headers.get("workos-signature");
        if (!sigHeader) {
          throw new Error("No signature header");
        }
        const secret = this.config.webhookSecret;
        if (!secret) {
          throw new Error("webhook secret is not set");
        }
        const event = await this.workos.webhooks.constructEvent({
          payload: JSON.parse(payload),
          sigHeader: sigHeader,
          secret,
        });
        if (this.config.logLevel === "DEBUG") {
          console.log("received event", event);
        }
        await ctx.runMutation(this.component.lib.enqueueWebhookEvent, {
          apiKey: this.config.apiKey,
          eventId: event.id,
          event: event.event,
          onEventHandle: this.config.authFunctions?.authKitEvent
            ? await createFunctionHandle(this.config.authFunctions.authKitEvent)
            : undefined,
          updatedAt:
            "updated_at" in event ? (event.updated_at as string) : undefined,
          eventTypes: this.config.additionalEventTypes,
          logLevel: this.config.logLevel,
        });
        return new Response("OK", { status: 200 });
      }),
    });
    http.route({
      path: "/workos/action",
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const payload = await request.text();
        const sigHeader = request.headers.get("workos-signature");
        if (!sigHeader) {
          throw new Error("No signature header");
        }
        const secret = this.config.actionSecret;
        if (!secret) {
          throw new Error("webhook secret is not set");
        }
        const action = await this.workos.actions.constructAction({
          payload: JSON.parse(payload),
          sigHeader: sigHeader,
          secret,
        });
        if (this.config.logLevel === "DEBUG") {
          console.log("received action", action);
        }
        if (!this.config.authFunctions?.authKitAction) {
          throw new Error(
            "authFunctions not set in AuthKit component configuration, or no authKitAction function exported"
          );
        }
        const responsePayload: WorkOSResponsePayload = await ctx.runMutation(
          // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
          this.config.authFunctions?.authKitAction!,
          {
            action,
          }
        );
        const response = await this.workos.actions.signResponse(
          responsePayload,
          // We check for this in the constructor
          this.config.actionSecret!
        );
        return new Response(JSON.stringify(response), { status: 200 });
      }),
    });
  }
}
