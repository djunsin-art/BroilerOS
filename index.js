// ============================================================
// BROILEROS BACKEND - MINIMAL VERSION (PASTI JALAN)
// ============================================================
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
// KONEKSI DATABASE (TETAP JALAN WALAUPUN GAGAL)
// ============================================================
console.log('🔌 Mencoba koneksi ke database...');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.log('⚠️ Server tetap berjalan tanpa database.');
    } else {
        console.log('✅ Database connected successfully.');
        release();
    }
});

pool.on('error', (err) => {
    console.error('❌ Database error:', err.message);
});

// ============================================================
// ROUTES (PASTIKAN SEMUA ADA)
// ============================================================

// 1. PING - test server hidup
app.get('/ping', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running!', timestamp: new Date().toISOString() });
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

// 3. HEALTH - health check standar
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 4. ADMIN SETUP - buat Super Admin (SEDERHANA)
app.post('/api/admin/setup', async (req, res) => {
    const { name, pin, farmName } = req.body;
    if (!name || !pin) {
        return res.status(400).json({ error: 'Name dan PIN wajib' });
    }
    // Sementara hanya return sukses (untuk testing)
    res.json({ 
        message: 'Setup received!', 
        data: { name, pin, farmName: farmName || 'Hemita Farm' } 
    });
});

// ============================================================
// START SERVER (PASTIKAN '0.0.0.0')
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 BroilerOS Backend running on port ${PORT}`);
    console.log(`📡 /ping - test server`);
    console.log(`📡 /test-db - test database`);
    console.log(`📡 /api/health - health check`);
    console.log(`📡 /api/admin/setup - create admin`);
});
