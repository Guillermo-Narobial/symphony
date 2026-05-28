import { z } from "zod";

const resourceSchema = z.object({
  resourceId: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const taskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  requirements: z.string().optional().default(""),
  customerRequirements: z.string().optional(),
  statusId: z.string().optional(),
  analystDeveloperId: z.string().optional(),
  projectManagerId: z.string().optional(),
  creationDate: z.string().optional(),
  creationHour: z.string().optional(),
  creationUser: z.string().optional(),
  assignedDate: z.string().optional(),
  countryId: z.string().optional(),
  brandId: z.string().optional(),
  userCode: z.string().optional(),
  customerId: z.string().optional(),
  groupId: z.string().optional(),
  typeId: z.union([z.string(), z.boolean()]).optional(),
  isProject: z.boolean().optional(),
  isOpened: z.boolean().optional(),
  isClosed: z.boolean().optional(),
  isNarobial: z.boolean().optional(),
  isQ700: z.boolean().optional(),
  isQuiter: z.boolean().optional(),
  isSuggestion: z.boolean().optional(),
  uploadDate: z.string().optional(),
  closingDate: z.string().optional(),
  narobialAppVersion: z.string().optional(),
  estimatedDevelopmentEndDate: z.string().optional(),
  developmentEndDate: z.string().optional(),
  developmentStartDate: z.string().optional(),
  pilotDate: z.string().optional(),
  resources: z.array(resourceSchema).optional(),
});

export type Task = z.infer<typeof taskSchema>;
