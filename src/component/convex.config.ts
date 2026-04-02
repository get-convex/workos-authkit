import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";
import workflow from "@convex-dev/workflow/convex.config";

const component = defineComponent("workOSAuthKit");

component.use(workpool, { name: "eventWorkpool" });
component.use(workflow, { name: "backfillWorkflow" });

export default component;
