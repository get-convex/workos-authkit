import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import workpool from "@convex-dev/workpool/test";
import workflow from "@convex-dev/workflow/test";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "workOSAuthKit"
) {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/eventWorkpool`);
  workflow.register(t, `${name}/backfillWorkflow`);
}
export default { register, schema, modules };
