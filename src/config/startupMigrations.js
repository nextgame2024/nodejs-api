import pool from "./db.js";

const BM_USER_TYPE_VALUES = ["employee", "supplier", "client"];

export async function ensureStartupMigrations() {
  await ensureBmUserTypeValues();
}

async function ensureBmUserTypeValues() {
  for (const value of BM_USER_TYPE_VALUES) {
    try {
      await pool.query(
        `ALTER TYPE bm_user_type ADD VALUE IF NOT EXISTS '${value}'`
      );
    } catch (error) {
      if (error?.code === "42704") {
        console.warn("bm_user_type enum not found; skipping user type sync");
        return;
      }
      throw error;
    }
  }
}
