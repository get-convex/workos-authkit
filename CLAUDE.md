# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Convex component that integrates WorkOS AuthKit authentication with Convex projects. It syncs user data from WorkOS to Convex via webhooks and allows handling WorkOS events/actions in Convex functions.

## Commands

```bash
# Development (runs backend, frontend, and build watch concurrently)
npm run dev

# Build the component
npm run build

# Run tests
npm test

# Run a single test file
npx vitest run src/component/setup.test.ts

# Run tests in watch mode
npm run test:watch

# Type checking
npm run typecheck

# Linting
npm run lint

# Full dev with tests
npm run all
```

## Architecture

### Directory Structure

- `src/client/` - Client-side AuthKit class exported as the main package entry point
- `src/component/` - Convex component internals (runs on Convex backend)
- `src/react/` - React bindings (re-exports from @workos-inc/authkit-react)
- `example/` - Demo Convex app showing component integration

### Key Components

**AuthKit Class (`src/client/index.ts`)**
- Main export that users instantiate in their `convex/` folder
- Handles WorkOS webhook signature verification
- Registers HTTP routes for webhooks (`/workos/webhook`) and actions (`/workos/action`)
- Provides `events()` and `actions()` methods for typed event/action handlers
- `getAuthUser()` method retrieves authenticated user from component's users table

**Component Library (`src/component/lib.ts`)**
- Internal Convex functions running within the component
- Uses Workpool for serialized event processing (`maxParallelism: 1`)
- `processEvent` handles user.created/updated/deleted events and syncs to component's users table
- Calls user-defined event handlers via function handles

**Component Schema (`src/component/schema.ts`)**
- `events` table: tracks processed webhook events (prevents duplicates)
- `users` table: mirrors WorkOS user data (id, email, firstName, lastName, etc.)

### Testing

Uses `convex-test` with edge-runtime environment. Components must be registered explicitly:

```typescript
import component from "@convex-dev/workos-authkit/test";
const t = convexTest(schema, modules);
t.registerComponent("workOSAuthKit", component.schema, component.modules);
```

### Environment Variables

- `WORKOS_CLIENT_ID` - WorkOS client ID
- `WORKOS_API_KEY` - WorkOS API key
- `WORKOS_WEBHOOK_SECRET` - Webhook signing secret
- `WORKOS_ACTION_SECRET` - Action signing secret (optional, for actions)

## Convex Guidelines

Follow the standard Convex function syntax with argument and return validators. Use `query`, `mutation`, `action` for public functions and `internalQuery`, `internalMutation`, `internalAction` for private functions. Always use `withIndex` instead of `filter` for queries.
