require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================
// KONEKSI DATABASE (TANPA CRASH)
// ============================================================
console.log('🔌 Connecting to database...');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ DB connection error:', err.message);
        console.log('⚠️ Server tetap berjalan tanpa DB.');
    } else {
        console.log('✅ DB connected.');
        release();
    }
});

pool.on('error', (err) => console.error('DB error:', err.message));

// ============================================================
// ROUTES (PASTIKAN INI ADA)
// ============================================================

// 1. PING - test server hidup
app.get('/ping', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running!' });
});

// 2. TEST DB - test koneksi database
app.get('/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ success: true, time: result.rows[0].now });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. ADMIN SETUP - buat Super Admin
app.post('/api/admin/setup', async (req, res) => {
    const { name, pin, farmName } = req.body;
    if (!name || !pin) {
        return res.status(400).json({ error: 'Name dan PIN wajib' });
    }
    // Sementara kita hanya kirim respons sukses (tanpa bcrypt dulu untuk testing)
    res.json({ message: 'Setup received! (DB not yet implemented)' });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 /ping - test server`);
    console.log(`📡 /test-db - test database`);
    console.log(`📡 /api/admin/setup - create admin`);
});
