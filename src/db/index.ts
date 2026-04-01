import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export let pool: Pool | null = null;
if (process.env.DATABASE_URL) {
    const isLocalhost = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: isLocalhost ? false : { rejectUnauthorized: false }
    });
}

export async function initDB() {
    if (!pool) return;
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB
      );
    `);
        console.log("✅ Database initialized successfully!");
    } catch (err) {
        console.error("❌ Database Init Error:", err);
    }
}
