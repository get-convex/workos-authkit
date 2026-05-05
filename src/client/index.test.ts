/// <reference types="vite/client" />
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkOS } from "@workos-inc/node";
import { AuthKit } from "./index.js";
import type { ComponentApi } from "../component/_generated/component.js";

vi.mock("@workos-inc/node", () => {
  return {
    WorkOS: vi.fn().mockImplementation(function () {
      return {};
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
