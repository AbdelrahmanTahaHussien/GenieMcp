import { z } from "zod";

const failureCategory = z.enum([
  "infrastructure",
  "translation",
  "assertion",
  "locator",
  "navigation",
  "unknown",
]);

const categoryCounts = z.record(z.number());

const historyFailureSchema = z.object({
  testTitle: z.string(),
  category: failureCategory,
  errorMessage: z.string(),
}).passthrough();

const attemptSchema = z.object({
  attempt: z.number().int().positive(),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  categories: categoryCounts,
  failures: z.array(historyFailureSchema),
  fixesApplied: z.array(z.object({
    type: z.string(),
    file: z.string().optional(),
    description: z.string(),
  }).passthrough()),
}).passthrough();

export const handoffSchemas = {
  plan: z.object({
    feature: z.string(),
    createdAt: z.string(),
    schemaVersion: z.number().int().positive().optional(),
  }).passthrough(),
  changeset: z.object({
    createdAt: z.string(),
    feature: z.string(),
    generatedSpec: z.string(),
    templateUsed: z.string().nullable(),
    filesChanged: z.array(z.string()),
    validation: z.object({
      playwrightListPassed: z.boolean(),
      command: z.string(),
      totalTests: z.number().int().nonnegative().optional(),
    }).passthrough(),
    schemaVersion: z.number().int().positive().optional(),
  }).passthrough(),
  "run-history": z.array(z.object({
    finishedAt: z.string(),
    spec: z.string(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    success: z.boolean(),
    schemaVersion: z.number().int().positive().optional(),
  }).passthrough()),
  "run-report": z.object({
    spec: z.string(),
    finishedAt: z.string(),
    success: z.boolean(),
    attempts: z.array(attemptSchema),
    summary: z.object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      categories: categoryCounts,
      allInfrastructure: z.boolean().optional(),
    }).passthrough(),
    failures: z.array(historyFailureSchema).optional(),
    schemaVersion: z.number().int().positive().optional(),
  }).passthrough(),
} as const;

export type HandoffName = keyof typeof handoffSchemas;
export const handoffNames = Object.keys(handoffSchemas) as HandoffName[];