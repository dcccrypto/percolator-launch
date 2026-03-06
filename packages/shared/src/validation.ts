import { z } from "zod";

/**
 * Base58 address schema (32-44 chars, base58 charset only)
 */
export const slabAddressSchema = z
  .string()
  .min(32, "Slab address must be at least 32 characters")
  .max(44, "Slab address must be at most 44 characters")
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Invalid base58 address");

/**
 * Market registration schema for POST /markets
 */
export const marketRegistrationSchema = z.object({
  slabAddress: slabAddressSchema,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

/**
 * Pagination schema with defaults
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * Environment variables schema
 * Required in production, optional with defaults in dev
 */
const envSchemaBase = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RPC_URL: z.string().url().optional(),
  FALLBACK_RPC_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(), // legacy fallback — prefer HELIUS_DEVNET/MAINNET_API_KEY
  HELIUS_DEVNET_API_KEY: z.string().optional(),
  HELIUS_MAINNET_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  CRANK_KEYPAIR: z.string().optional(),
  PROGRAM_ID: z.string().optional(),
  ALL_PROGRAM_IDS: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  CRANK_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  CRANK_INACTIVE_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  HELIUS_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_URL: z.string().url().optional(),
});

export type EnvSchema = z.infer<typeof envSchemaBase>;

/**
 * Production refinement: require critical env vars
 */
const envSchema = envSchemaBase.superRefine((data, ctx) => {
  if (data.NODE_ENV === "production") {
    // Critical production requirements
    if (!data.RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RPC_URL is required in production",
        path: ["RPC_URL"],
      });
    }
    if (!data.SUPABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SUPABASE_URL is required in production",
        path: ["SUPABASE_URL"],
      });
    }
    if (!data.SUPABASE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SUPABASE_KEY is required in production",
        path: ["SUPABASE_KEY"],
      });
    }
    if (!data.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SUPABASE_SERVICE_ROLE_KEY is required in production",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
      });
    }
  }
});

/**
 * Validate environment variables at startup
 * Throws clear errors on missing vars in production
 */
export function validateEnv(): EnvSchema {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((err: z.ZodIssue) => `  - ${err.path.join(".")}: ${err.message}`)
      .join("\n");
    
    throw new Error(`Environment validation failed:\n${errors}`);
  }

  return result.data;
}
