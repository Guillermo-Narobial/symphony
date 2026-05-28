import { taskSchema } from "./schema.js";
import { createIssue } from "./issuer.js";
import { notifyRejection } from "./notifier.js";
import { validateQ700 } from "./q700-validator.js";
import { notifyRejectionEmail } from "./notifier-email.js";

export async function processTask(raw: unknown): Promise<void> {
  const result = taskSchema.safeParse(raw);

  if (!result.success) {
    const id = (raw as Record<string, unknown>)?.id ?? "desconocido";
    const reason = result.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    const url = await notifyRejection(String(id), reason);
    console.log(`❌ Tarea ${id} rechazada (schema): ${url}`);
    return;
  }

  const task = result.data;

  // Validación Q700: ¿información suficiente, coherente y accionable?
  const q700 = validateQ700(task);
  if (q700.status === "RECHAZADA") {
    const reason = [
      `**Estado:** ${q700.status}`,
      `**Motivo:** ${q700.reason}`,
      `**Datos faltantes o inconsistentes:**\n${q700.missingOrInconsistent.map((d) => `- ${d}`).join("\n")}`,
      `**Acción recomendada:** ${q700.recommendedAction}`,
    ].join("\n\n");
    await notifyRejectionEmail(task.id, reason);
    console.log(`❌ Tarea ${task.id} rechazada (Q700) — email enviado`);
    return;
  }

  const url = await createIssue(task);
  console.log(`✅ Tarea ${task.id}: ${url}`);
}
