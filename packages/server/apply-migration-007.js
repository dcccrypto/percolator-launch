const { Client } = require('pg');
const fs = require('fs');

const client = new Client({
  connectionString: 'postgresql://postgres.ygvbajglkrwkbjdjyhxi:Khubaircobra_123@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
  try {
    await client.connect();
    console.log('Connected to Supabase');
    
    const sql = fs.readFileSync('../../supabase/migrations/007_hidden_features.sql', 'utf8');
    console.log('Executing migration 007...');
    
    await client.query(sql);
    console.log('✅ Migration 007 applied successfully');
    
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applyMigration();
