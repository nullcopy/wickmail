import type { Migration } from "../migrations.js";
import { initialSchemaMigration } from "./0001_initial_schema.js";
import { authAndAbuseMigration } from "./0002_auth_and_abuse.js";

/**
 * Every migration, in version order. Append new migrations here; never edit an
 * applied migration.
 */
export const migrations: readonly Migration[] = [initialSchemaMigration, authAndAbuseMigration];
