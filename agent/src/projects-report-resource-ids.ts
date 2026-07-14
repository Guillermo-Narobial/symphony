export interface ProjectResource {
  resourceId?: string;
}

export interface ProjectResourceInput {
  id: string;
  analystDeveloperId?: string;
  resources?: ProjectResource[];
}

export function analystDeveloperIds(value?: string): string[] {
  return (value ?? "").split("²").map((id) => id.trim()).filter(Boolean);
}

export function projectResourceIds(
  project: ProjectResourceInput,
  onMissingAnalystDeveloperId?: (projectId: string) => void,
): string[] {
  if (!(project.analystDeveloperId ?? "").trim()) {
    onMissingAnalystDeveloperId?.(project.id);
  }

  const ids = new Set<string>(analystDeveloperIds(project.analystDeveloperId));
  for (const resource of project.resources ?? []) {
    if (resource.resourceId) ids.add(resource.resourceId);
  }

  return [...ids];
}
