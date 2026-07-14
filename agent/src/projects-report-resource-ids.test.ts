import assert from "node:assert/strict";
import test from "node:test";
import { projectResourceIds } from "./projects-report-resource-ids.js";

test("mantiene recursos de un Q700 sin analystDeveloperId", () => {
  const missingProjects: string[] = [];
  const ids = projectResourceIds({
    id: "Q05532026MX",
    resources: [
      { resourceId: "babuhassira" },
      { resourceId: "gcalleja" },
    ],
  }, (projectId) => missingProjects.push(projectId));

  assert.deepEqual(ids, ["babuhassira", "gcalleja"]);
  assert.deepEqual(missingProjects, ["Q05532026MX"]);
});
