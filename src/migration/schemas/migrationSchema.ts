import { z } from "zod";

export const MigrationActionSchema = z.enum(["modify", "delete", "create"]);

export const MigrationTaskCategorySchema = z.enum(["config", "code", "build", "resource"]);

export const MigrationTaskSchema = z.object({
  id: z.string().min(1).default(() => `task-${Math.random().toString(36).slice(2, 9)}`),
  file: z.string().min(1, "File path cannot be empty"),
  action: MigrationActionSchema,
  description: z.string().min(10, "Description must be at least 10 characters"),
  priority: z.number().min(0).max(10).optional(),
  type: MigrationTaskCategorySchema.optional(),
  files: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
});

export const MigrationSummarySchema = z.object({
  filesToModify: z.number().min(0),
  filesToDelete: z.number().min(0),
  filesToCreate: z.number().min(0),
});

export const MigrationPlanSchema = z.object({
  migrationType: z.string().min(1, "Migration type is required"),
  summary: MigrationSummarySchema,
  tasks: z.array(MigrationTaskSchema).min(1, "At least one task is required"),
  estimatedComplexity: z.enum(["low", "medium", "high"]).optional(),
});

export const BuildErrorSchema = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
  type: z.enum(["compilation", "dependency", "configuration", "unknown"]),
});

export const BuildValidationResultSchema = z.object({
  success: z.boolean(),
  buildTool: z.enum(["maven", "gradle", "npm", "unknown"]),
  errors: z.array(BuildErrorSchema),
  warnings: z.array(z.string()),
  logs: z.string(),
  exitCode: z.number(),
});

export const FileOperationSchema = z.object({
  file: z.string(),
  action: MigrationActionSchema,
  content: z.string().optional(),
  previousContent: z.string().optional(),
});

export const RepairResultSchema = z.object({
  success: z.boolean(),
  fixes: z.array(FileOperationSchema),
  reasoning: z.string(),
});

export type MigrationPlanType = z.infer<typeof MigrationPlanSchema>;
export type MigrationTaskType = z.infer<typeof MigrationTaskSchema>;
export type BuildValidationResultType = z.infer<typeof BuildValidationResultSchema>;
export type RepairResultType = z.infer<typeof RepairResultSchema>;
