import type { Task } from "./schema.js";

export interface Q700ValidationResult {
  status: "APROBADA" | "RECHAZADA";
  reason: string;
  missingOrInconsistent: string[];
  recommendedAction: string;
}

interface Check {
  test: (task: Task) => boolean;
  field: string;
  message: string;
}

const CHECKS: Check[] = [
  {
    test: (t) => !t.requirements || t.requirements.trim().length < 20,
    field: "requirements",
    message: "Requisitos vacíos o demasiado cortos para ser accionables",
  },
  {
    test: (t) => !t.countryId,
    field: "countryId",
    message: "País no especificado — imposible determinar contexto regional",
  },
  {
    test: (t) => !t.brandId,
    field: "brandId",
    message: "Marca no especificada — no se puede acotar el alcance",
  },
  {
    test: (t) => !t.customerId,
    field: "customerId",
    message: "Cliente no identificado",
  },
  {
    test: (t) => {
      const req = (t.requirements || "").toLowerCase();
      // Detectar contradicciones obvias
      return (req.includes("no funciona") && req.includes("funciona correctamente"))
        || (req.includes("añadir") && req.includes("eliminar") && req.length < 80);
    },
    field: "requirements",
    message: "Requisitos contradictorios detectados",
  },
  {
    test: (t) => {
      const req = (t.requirements || "").toLowerCase();
      // Solo contiene texto genérico sin detalle funcional
      const generic = ["revisar", "arreglar", "mirar", "ver", "comprobar"];
      const words = req.split(/\s+/);
      return words.length < 6 && generic.some((g) => req.includes(g));
    },
    field: "requirements",
    message: "Descripción demasiado genérica/ambigua — no permite reproducir ni entender el problema",
  },
  {
    test: (t) => {
      // Si tiene customerRequirements, debe tener algo de sustancia
      const cr = t.customerRequirements || "";
      return cr.length > 0 && cr.trim().length < 10;
    },
    field: "customerRequirements",
    message: "Requisitos del cliente presentes pero insuficientes",
  },
];

export function validateQ700(task: Task): Q700ValidationResult {
  const failures = CHECKS.filter((c) => c.test(task));

  if (failures.length === 0) {
    return {
      status: "APROBADA",
      reason: "Q700 válido — información suficiente y coherente",
      missingOrInconsistent: [],
      recommendedAction: "Crear issue",
    };
  }

  return {
    status: "RECHAZADA",
    reason: `Q700 no accionable: ${failures.length} problema(s) detectado(s)`,
    missingOrInconsistent: failures.map((f) => `[${f.field}] ${f.message}`),
    recommendedAction: failures.map((f) => `Completar/corregir: ${f.field}`).join("; "),
  };
}
