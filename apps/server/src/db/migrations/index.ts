import type { Migration } from "../migrations.js";
import { initialSchemaMigration } from "./0001_initial_schema.js";

/**
 * Every migration, in version order. Append new migrations here; never edit an
 * applied migration.
 */
export const migrations: readonly Migration[] = [initialSchemaMigration];
