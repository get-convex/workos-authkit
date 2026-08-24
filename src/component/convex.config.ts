import { defineComponent } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";

const component = defineComponent("workOSAuthKit");

component.use(workflow, { name: "backfillWorkflow" });

export default component;
