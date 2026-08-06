/// <reference types="vite/client" />
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkOS } from "@workos-inc/node";
import { AuthKit } from "./index.js";
import type { ComponentApi } from "../component/_generated/component.js";

const workosMocks = vi.hoisted(() => ({
  constructAction: vi.fn(),
  constructEvent: vi.fn(),
  signResponse: vi.fn(),
}));

vi.mock("@workos-inc/node", () => {
  return {
    WorkOS: vi.fn().mockImplementation(function () {
      return {
        actions: {
          constructAction: workosMocks.constructAction,
          signResponse: workosMocks.signResponse,
        },
        webhooks: {
          constructEvent: workosMocks.constructEvent,
        },
      };
    }),
  };
});

const requiredEnv = {
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  WORKOS_WEBHOOK_SECRET: "whsec_test",
};

const fakeComponent = {} as ComponentApi;

describe("AuthKit constructor", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(requiredEnv)) {
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(requiredEnv)) {
      delete process.env[k];
    }
    vi.clearAllMocks();
  });

  describe("apiHostname", () => {
    test("forwards apiHostname option to the WorkOS SDK", () => {
      new AuthKit(fakeComponent, { apiHostname: "auth.example.com" });
      expect(vi.mocked(WorkOS)).toHaveBeenCalledWith(
        "sk_test",
        expect.objectContaining({ apiHostname: "auth.example.com" })
      );
    });

    test("forwards undefined when option is not set", () => {
      new AuthKit(fakeComponent);
      expect(vi.mocked(WorkOS)).toHaveBeenCalledWith(
        "sk_test",
        expect.objectContaining({ apiHostname: undefined })
      );
    });
  });

  test("clientId is forwarded to the WorkOS SDK", () => {
    new AuthKit(fakeComponent);
    expect(vi.mocked(WorkOS)).toHaveBeenCalledWith(
      "sk_test",
      expect.objectContaining({ clientId: "client_test" })
    );
  });
});

describe("AuthKit.getAuthConfigProviders", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(requiredEnv)) {
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(requiredEnv)) {
      delete process.env[k];
    }
    vi.clearAllMocks();
  });

  test("falls back to api.workos.com when no custom hostname is set", () => {
    const authKit = new AuthKit(fakeComponent);
    const providers = authKit.getAuthConfigProviders();
    expect(providers[0].issuer).toBe("https://api.workos.com/");
    expect(providers[0].jwks).toBe(
      "https://api.workos.com/sso/jwks/client_test"
    );
    expect(providers[1].issuer).toBe(
      "https://api.workos.com/user_management/client_test"
    );
    expect(providers[1].jwks).toBe(
      "https://api.workos.com/sso/jwks/client_test"
    );
  });

  test("custom hostname rewrites issuer but not jwks", () => {
    const authKit = new AuthKit(fakeComponent, {
      apiHostname: "auth.example.com",
    });
    const providers = authKit.getAuthConfigProviders();
    expect(providers[0].issuer).toBe("https://auth.example.com/");
    expect(providers[0].jwks).toBe(
      "https://api.workos.com/sso/jwks/client_test"
    );
    expect(providers[1].issuer).toBe(
      "https://auth.example.com/user_management/client_test"
    );
    expect(providers[1].jwks).toBe(
      "https://api.workos.com/sso/jwks/client_test"
    );
  });
});

describe("AuthKit.registerRoutes", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(requiredEnv)) {
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(requiredEnv)) {
      delete process.env[k];
    }
    vi.clearAllMocks();
  });

  test.each([
    ["/workos/webhook", workosMocks.constructEvent],
    ["/workos/action", workosMocks.constructAction],
  ] as const)(
    "passes the exact raw body to %s verification",
    async (path, verify) => {
      const authKit = new AuthKit(fakeComponent, {
        actionSecret: "action_secret",
      });
      const route = vi.fn();
      authKit.registerRoutes({ route } as never);

      const registeredRoute = route.mock.calls.find(
        ([candidate]) => candidate.path === path
      )?.[0];
      expect(registeredRoute).toBeDefined();

      const rawBody = '{\n  "value": "\\u003c"\n}';
      const request = new Request(`https://example.com${path}`, {
        method: "POST",
        headers: { "workos-signature": "t=123,v1=abc" },
        body: rawBody,
      });
      const stopAfterVerification = new Error("stop after verification");
      verify.mockRejectedValueOnce(stopAfterVerification);

      await expect(registeredRoute!.handler._handler({}, request)).rejects.toBe(
        stopAfterVerification
      );
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ payload: rawBody })
      );
    }
  );
});
