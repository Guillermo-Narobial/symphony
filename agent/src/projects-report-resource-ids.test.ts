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


import { isReportHealthy } from "./projects-report-verifier-logic.js";

test("acepta un informe exitoso ejecutado hoy", () => {
  assert.equal(isReportHealthy({ Result: "success", ExecMainStatus: "0", ActiveExitTimestamp: "Wed 2026-07-15 14:30:00 CEST" }, "2026-07-15"), true);
});

test("rechaza un éxito antiguo aunque el servicio indique success", () => {
  assert.equal(isReportHealthy({ Result: "success", ExecMainStatus: "0", ActiveExitTimestamp: "Tue 2026-07-14 14:30:00 CEST" }, "2026-07-15"), false);
});

test("rechaza un timestamp ausente o inválido", () => {
  assert.equal(isReportHealthy({ Result: "success", ExecMainStatus: "0", ActiveExitTimestamp: "-" }, "2026-07-15"), false);
});
