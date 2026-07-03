// ============================================================
// BROILEROS v2.1 FINAL - BACKEND COMPLETE (Render Ready)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'broileros-super-secret-key';

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================
app.use(helmet());

const allowedOrigins = [
    'https://broileros-app.pages.dev',
    'https://broileros.hemitafarm.com',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://broileros-backend.onrender.com' // Tambahkan domain Render Anda
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Terlalu banyak percobaan login. Coba lagi 15 menit.' }
});

app.use(express.json({ limit: '10mb' }));

// ============================================================
// ROUTE KESEHATAN (DITEMPATKAN PALING ATAS UNTUK TESTING)
// ============================================================
app.get('/', (req, res) => {
    res.send('BroilerOS Backend is running!');
});

app.get('/api/health', (req, res) => {
    console.log('✅ Health route accessed at', new Date().toISOString());
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ============================================================
// DATABASE CONNECTION
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Test database connection (untuk debugging)
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully at', res.rows[0].now);
    }
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function auth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query(
            'SELECT id, name, role, farm_id, barn_id, floor_id, is_super_admin FROM users WHERE id = $1 AND active = true',
            [decoded.id]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = result.rows[0];
        req.isSuperAdmin = req.user.is_super_admin || false;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============================================================
// HELPERS (THI, RISK, WATER, DWP)
// ============================================================
function calculateTHI(t, h) { const tf = 1.8 * t + 32; return Math.round((tf - (0.55 - 0.0055 * h) * (tf - 58)) * 10) / 10; }
function getTHIZone(age, thi) {
    const zones = [{min:0,max:7,comfort:92,alert:95},{min:8,max:14,comfort:89,alert:93},{min:15,max:21,comfort:86,alert:90},{min:22,max:28,comfort:84,alert:88},{min:29,max:35,comfort:81,alert:85},{min:36,max:60,comfort:79,alert:83}];
    const z = zones.find(z => age >= z.min && age <= z.max) || zones[zones.length-1];
    if (thi > z.alert) return 'danger'; if (thi > z.comfort) return 'alert'; return 'comfort';
}
function calculateRisk(age, thi, zone, mort, pop, wind, wir) {
    let s = 0; const zones = { comfort: [0,10], alert: [10,30], danger: [30,40] };
    const [mn, mx] = zones[zone] || zones.comfort; s += mn + (mx - mn) * ((thi % 10) / 10);
    const mr = pop > 0 ? (mort / pop) * 100 : 0; if (mr > 0.5) s += 30; else if (mr > 0.2) s += 20; else if (mr > 0.05) s += 10;
    if (wind < 1) s += 15; else if (wind < 1.5) s += 10; else if (wind < 2) s += 5;
    const ref = { lo: 1.5, hi: 3.0 }; if (age <= 7) { ref.lo = 1.5; ref.hi = 2.0; } else if (age <= 14) { ref.lo = 1.7; ref.hi = 2.2; } else if (age <= 21) { ref.lo = 1.8; ref.hi = 2.3; } else if (age <= 28) { ref.lo = 1.9; ref.hi = 2.5; } else if (age <= 35) { ref.lo = 2.0; ref.hi = 2.8; } else { ref.lo = 2.0; ref.hi = 3.0; }
    if (wir > ref.hi + 0.5) s += 10; else if (wir > ref.hi) s += 6;
    if (age >= 14 && age <= 28) s += 5; else if (age >= 7 && age <= 35) s += 3; else s += 1;
    return Math.min(100, Math.round(s));
}
function getRiskLevel(s) { if (s < 25) return 'RENDAH'; if (s < 50) return 'SEDANG'; if (s < 75) return 'TINGGI'; return 'KRITIS'; }
function getDWPPhase(age) { if (age <= 3) return 'START DOC'; if (age <= 7) return 'STARTER AWAL'; if (age <= 14) return 'STARTER AKHIR'; if (age <= 21) return 'GROWER AWAL'; if (age <= 28) return 'GROWER AKHIR'; if (age <= 35) return 'FINISHER AWAL'; return 'FINISHER AKHIR'; }

async function getFloorConfig(floorId) {
    try {
        const res = await pool.query(`
            SELECT fc.*, f.default_population, f.default_density, f.meta_data as floor_meta
            FROM floors f LEFT JOIN floor_configs fc ON f.id = fc.floor_id WHERE f.id = $1
        `, [floorId]);
        if (res.rows.length > 0) {
            const row = res.rows[0];
            return { floor_id: row.floor_id, elevation_meters: row.elevation_meters || 0, roof_type: row.roof_type || 'metal', orientation: row.orientation || 'ew', nipple_flow_rate: row.nipple_flow_rate_ml_min || 90, water_pressure: row.water_pressure_psi || 3.5, health_risk_score: row.health_risk_score || 0, meta_data: row.meta_data || {} };
        }
    } catch(e) {}
    return { floor_id: floorId, elevation_meters: 0, roof_type: 'standard', orientation: 'ew', nipple_flow_rate: 90, water_pressure: 3.5, health_risk_score: 0, meta_data: {} };
}

async function getWaterBaseline(floorId, age) {
    try {
        const res = await pool.query('SELECT baseline_ml_per_bird FROM water_baselines WHERE floor_id = $1 AND age_days = $2', [floorId, age]);
        if (res.rows.length > 0) return res.rows[0].baseline_ml_per_bird;
    } catch(e) {}
    const defaultBaseline = { 1:68, 7:116, 14:175, 21:222, 28:268, 35:315, 42:435 };
    const ages = Object.keys(defaultBaseline).map(Number);
    let base = defaultBaseline[age]; if (!base) { const nearest = ages.reduce((a, b) => Math.abs(a - age) < Math.abs(b - age) ? a : b); base = defaultBaseline[nearest]; }
    return base;
}

function calculateWaterModifiers(temp, hum, wind, weight, age, baseline, config) {
    const elevationFactor = 1 - (config.elevation_meters / 1000) * 0.02;
    let tempFactor = 1 + Math.max(0, (temp - 23) * 0.05) * elevationFactor;
    let humFactor = 1; if (hum > 70) humFactor += 0.02 * ((hum - 70) / 10); if (hum < 50) humFactor += 0.03 * ((50 - hum) / 10);
    const stdWeight = 0.04 + age * 0.052;
    const bwFactor = weight && weight > 0 ? 1 + (weight - stdWeight) / stdWeight * 0.5 : 1;
    const windFactor = 1 + Math.max(0, (wind - 1) * 0.03);
    const healthFactor = 1 + (config.health_risk_score / 100) * 0.1;
    return { tempFactor: Math.round(tempFactor * 100) / 100, humFactor: Math.round(humFactor * 100) / 100, bwFactor: Math.round(bwFactor * 100) / 100, windFactor: Math.round(windFactor * 100) / 100, healthFactor: Math.round(healthFactor * 100) / 100, combined: Math.round(tempFactor * humFactor * bwFactor * windFactor * healthFactor * 100) / 100 };
}

async function calculateDWPNeed(floorId, ageDays, totalBirds, estimatedWaterLiters) {
    let productSkus = ['DWPBE'];
    if (ageDays <= 3) { productSkus = ['DWPSD']; }
    else if ([3, 7, 14, 21].includes(ageDays)) { productSkus = ['DWPBE', 'DWPPRO']; }
    else {
        // Simulasi heat risk (nanti bisa dari water analytics)
        if (ageDays > 25 && ageDays < 35) productSkus = ['DWPH-A'];
    }
    const results = [];
    for (const sku of productSkus) {
        const prod = await pool.query('SELECT * FROM dwp_products WHERE sku = $1', [sku]);
        if (prod.rows.length === 0) continue;
        const p = prod.rows[0];
        const totalGrams = (estimatedWaterLiters / 1000) * parseFloat(p.grams_per_1000l);
        const packages = Math.ceil(totalGrams / parseFloat(p.package_size_grams));
        results.push({ product: p, totalGrams: Math.round(totalGrams * 10) / 10, packages: packages, price: packages * parseFloat(p.price_per_package) });
    }
    return results;
}

// ============================================================
// API ROUTES
// ============================================================
app.get('/api/users/public', async (req, res) => {
    const { role } = req.query;
    let query = 'SELECT id, name, role FROM users WHERE active = true';
    const params = [];
    if (role) { query += ' AND role = $1'; params.push(role); }
    const result = await pool.query(query, params);
    res.json(result.rows);
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) return res.status(400).json({ error: 'User ID dan PIN wajib' });
    if (!userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) return res.status(400).json({ error: 'Format User ID tidak valid' });
    if (!pin.match(/^[0-9]{4,6}$/)) return res.status(400).json({ error: 'PIN harus 4-6 digit angka' });
    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND active = true', [userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User tidak ditemukan' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) return res.status(401).json({ error: 'PIN salah' });
    const farm = await pool.query('SELECT name FROM farms WHERE id = $1', [user.farm_id]);
    const token = jwt.sign({ id: user.id, role: user.role, farm_id: user.farm_id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, farm_id: user.farm_id, barn_id: user.barn_id, floor_id: user.floor_id, farm_name: farm.rows[0]?.name || 'Farm', is_super_admin: user.is_super_admin || false } });
});

// === BARNS ===
app.get('/api/barns', auth, async (req, res) => {
    let query = `SELECT b.*, json_agg(f.*) as floors FROM barns b LEFT JOIN floors f ON b.id = f.barn_id`;
    let params = [];
    if (req.isSuperAdmin) { if (req.query.farm_id) { query += ' WHERE b.farm_id = $1'; params.push(req.query.farm_id); } }
    else { query += ' WHERE b.farm_id = $1'; params.push(req.user.farm_id); }
    query += ' GROUP BY b.id';
    const result = await pool.query(query, params);
    res.json(result.rows);
});

// === FLOOR CONFIG ===
app.get('/api/floors/:id/config', auth, async (req, res) => { const config = await getFloorConfig(req.params.id); res.json(config); });
app.post('/api/floors/:id/config', auth, async (req, res) => {
    if (req.user.role !== 'manager' && !req.isSuperAdmin) return res.status(403).json({ error: 'Hanya Manager' });
    const { id } = req.params;
    const { elevation_meters, roof_type, orientation, nipple_flow_rate_ml_min, water_pressure_psi, meta_data } = req.body;
    const query = `
        INSERT INTO floor_configs (floor_id, elevation_meters, roof_type, orientation, nipple_flow_rate_ml_min, water_pressure_psi, meta_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (floor_id) DO UPDATE SET elevation_meters = EXCLUDED.elevation_meters, roof_type = EXCLUDED.roof_type, orientation = EXCLUDED.orientation, nipple_flow_rate_ml_min = EXCLUDED.nipple_flow_rate_ml_min, water_pressure_psi = EXCLUDED.water_pressure_psi, meta_data = EXCLUDED.meta_data, updated_at = NOW()
        RETURNING *
    `;
    const values = [id, elevation_meters, roof_type, orientation, nipple_flow_rate_ml_min, water_pressure_psi, meta_data || {}];
    const result = await pool.query(query, values);
    res.json({ success: true, config: result.rows[0] });
});

// === WATER PREDICT ===
app.post('/api/water/predict', auth, async (req, res) => {
    const { floorId, ageDays, temperature, humidity, windSpeed, population, weightAvg } = req.body;
    if (!floorId || !ageDays) return res.status(400).json({ error: 'floorId dan ageDays wajib' });
    const config = await getFloorConfig(floorId);
    const baseline = await getWaterBaseline(floorId, ageDays);
    const mods = calculateWaterModifiers(temperature, humidity, windSpeed, weightAvg, ageDays, baseline, config);
    const expectedPerBird = baseline * mods.combined;
    const expectedTotal = (expectedPerBird * population) / 1000;
    res.json({ baseline_ml: Math.round(baseline * 10) / 10, expected_ml: Math.round(expectedPerBird * 10) / 10, expected_liters: Math.round(expectedTotal * 10) / 10, modifiers: mods, config: { elevation: config.elevation_meters, roof: config.roof_type } });
});

// === TELEMETRY ===
app.post('/api/telemetry', auth, async (req, res) => {
    const { barnId, floorId, ageDays, temperature, humidity, mortality, windSpeed, waterConsumption, feedConsumption, population } = req.body;
    let pop = population; if (!pop) { const fRes = await pool.query('SELECT default_population FROM floors WHERE id = $1', [floorId]); pop = fRes.rows[0]?.default_population || 0; }
    const thi = calculateTHI(temperature, humidity);
    const zone = getTHIZone(ageDays, thi);
    const wir = feedConsumption > 0 ? waterConsumption / feedConsumption : 0;
    const riskScore = calculateRisk(ageDays, thi, zone, mortality || 0, pop, windSpeed || 0, wir);
    const level = getRiskLevel(riskScore);
    const heatStress = zone === 'danger';
    const dwpPhase = getDWPPhase(ageDays);
    const result = await pool.query(
        `INSERT INTO telemetry_reports (farm_id, barn_id, floor_id, user_id, age_days, population, temperature, humidity, mortality, wind_speed, water_consumption, feed_consumption, thi, thi_zone, wir, risk_score, risk_level, heat_stress, dwp_phase)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
        [req.user.farm_id, barnId, floorId, req.user.id, ageDays, pop, temperature, humidity, mortality || 0, windSpeed || 0, waterConsumption || 0, feedConsumption || 0, thi, zone, wir, riskScore, level, heatStress, dwpPhase]
    );
    const reportId = result.rows[0].id;

    // Water Analytics
    if (waterConsumption && waterConsumption > 0) {
        const config = await getFloorConfig(floorId);
        const baseline = await getWaterBaseline(floorId, ageDays);
        const mods = calculateWaterModifiers(temperature, humidity, windSpeed, null, ageDays, baseline, config);
        const expectedPerBird = baseline * mods.combined;
        const expectedTotal = (expectedPerBird * pop) / 1000;
        const actualPerBird = (waterConsumption * 1000) / pop;
        const anomaly = (actualPerBird - expectedPerBird) / expectedPerBird * 100;
        let anomalyLevel = 'normal';
        if (Math.abs(anomaly) > 15) anomalyLevel = 'critical';
        else if (Math.abs(anomaly) > 8) anomalyLevel = 'warning';
        await pool.query(`
            INSERT INTO water_analytics (floor_id, report_date, age_days, population, temperature, humidity, wind_speed, actual_water_liters, actual_water_per_bird, expected_baseline_ml, expected_with_modifiers_ml, anomaly_score, anomaly_level, temp_factor, hum_factor, bw_factor, health_factor)
            VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [floorId, ageDays, pop, temperature, humidity, windSpeed || 0, waterConsumption, actualPerBird, baseline, expectedPerBird, anomaly, anomalyLevel, mods.tempFactor, mods.humFactor, mods.bwFactor, mods.healthFactor]);
        if (anomalyLevel === 'critical') {
            await pool.query(`INSERT INTO alarms (farm_id, barn_id, floor_id, severity, category, message, triggered_by_user_id)
                VALUES ($1, $2, $3, 'critical', 'water', $4, $5)`,
                [req.user.farm_id, barnId, floorId, `Konsumsi air menyimpang ${Math.round(anomaly)}% dari prediksi. Segera periksa!`, req.user.id]);
        }
    }
    res.status(201).json({ id: reportId });
});

// === FLOOR DAILY STATUS ===
app.post('/api/floor/status', auth, async (req, res) => {
    const { floorId, ageDays, populationStart, mortalityToday, culledToday, soldToday, avgWeightKg, totalWeightKg, fcr, notes, causeCategory } = req.body;
    if (!floorId || !ageDays) return res.status(400).json({ error: 'floorId dan ageDays wajib' });
    const popEnd = populationStart - (mortalityToday || 0) - (culledToday || 0) - (soldToday || 0);
    await pool.query(`
        INSERT INTO floor_daily_status (floor_id, report_date, age_days, population_start, mortality_today, culled_today, sold_today, population_end, avg_weight_kg, total_weight_kg, feed_conversion_ratio, notes, cause_category, created_by)
        VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (floor_id, report_date) DO UPDATE SET age_days = EXCLUDED.age_days, population_start = EXCLUDED.population_start, mortality_today = EXCLUDED.mortality_today, culled_today = EXCLUDED.culled_today, sold_today = EXCLUDED.sold_today, population_end = EXCLUDED.population_end, avg_weight_kg = EXCLUDED.avg_weight_kg, total_weight_kg = EXCLUDED.total_weight_kg, feed_conversion_ratio = EXCLUDED.feed_conversion_ratio, notes = EXCLUDED.notes, cause_category = EXCLUDED.cause_category, updated_at = NOW()
    `, [floorId, ageDays, populationStart, mortalityToday || 0, culledToday || 0, soldToday || 0, popEnd, avgWeightKg || 0, totalWeightKg || 0, fcr || 0, notes, causeCategory, req.user.id]);
    res.json({ success: true, population_end: popEnd });
});

// === DWP ===
app.post('/api/dwp/calculate', auth, async (req, res) => {
    const { floorId, ageDays, totalBirds, estimatedWaterLiters } = req.body;
    if (!floorId || !ageDays || !totalBirds || !estimatedWaterLiters) return res.status(400).json({ error: 'Data tidak lengkap' });
    const results = await calculateDWPNeed(floorId, ageDays, totalBirds, estimatedWaterLiters);
    res.json({ products: results, totalPrice: results.reduce((sum, r) => sum + r.price, 0) });
});
app.post('/api/dwp/order', auth, async (req, res) => {
    const { floorId, ageDays, totalBirds } = req.body;
    if (!floorId || !ageDays || !totalBirds) return res.status(400).json({ error: 'Data tidak lengkap' });
    const waterRes = await pool.query('SELECT AVG(actual_water_liters) as avg_water FROM water_analytics WHERE floor_id = $1 AND age_days >= $2 - 3', [floorId, ageDays]);
    const estWater = waterRes.rows[0]?.avg_water || totalBirds * 0.3;
    const results = await calculateDWPNeed(floorId, ageDays, totalBirds, estWater);
    for (const r of results) {
        await pool.query(`INSERT INTO dwp_prescriptions (floor_id, product_id, age_days, total_birds, estimated_water_liters, required_product_units, required_packages, total_price, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
            [floorId, r.product.id, ageDays, totalBirds, estWater, r.totalGrams, r.packages, r.price]);
    }
    res.json({ success: true, order_count: results.length });
});

// === FEED MANAGEMENT ===
app.get('/api/feed/inventory/:floorId', auth, async (req, res) => {
    const { floorId } = req.params;
    const result = await pool.query('SELECT * FROM feed_inventory WHERE floor_id = $1', [floorId]);
    if (result.rows.length === 0) { await pool.query('INSERT INTO feed_inventory (floor_id, current_stock_kg) VALUES ($1, 0)', [floorId]); return res.json({ floor_id: floorId, current_stock_kg: 0, meta_data: {} }); }
    res.json(result.rows[0]);
});
app.post('/api/feed/receipt', auth, async (req, res) => {
    const { floorId, receivedDate, quantityKg, feedType, supplier, batchNumber } = req.body;
    if (!floorId || !quantityKg) return res.status(400).json({ error: 'floorId dan quantity wajib' });
    await pool.query(`INSERT INTO feed_receipts (floor_id, received_date, quantity_kg, feed_type, supplier, batch_number, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [floorId, receivedDate || new Date().toISOString().split('T')[0], quantityKg, feedType, supplier, batchNumber, req.user.id]);
    await pool.query(`INSERT INTO feed_inventory (floor_id, current_stock_kg) VALUES ($1, $2) ON CONFLICT (floor_id) DO UPDATE SET current_stock_kg = feed_inventory.current_stock_kg + EXCLUDED.current_stock_kg, last_updated = NOW()`, [floorId, quantityKg]);
    res.json({ success: true });
});
app.post('/api/feed/transfer', auth, async (req, res) => {
    const { fromFloorId, toFloorId, transferDate, quantityKg, reason } = req.body;
    if (!fromFloorId || !toFloorId || !quantityKg) return res.status(400).json({ error: 'fromFloorId, toFloorId, quantity wajib' });
    if (fromFloorId === toFloorId) return res.status(400).json({ error: 'Tidak bisa transfer ke kandang sendiri' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`UPDATE feed_inventory SET current_stock_kg = current_stock_kg - $1, last_updated = NOW() WHERE floor_id = $2 AND current_stock_kg >= $1`, [quantityKg, fromFloorId]);
        await client.query(`INSERT INTO feed_inventory (floor_id, current_stock_kg) VALUES ($1, $2) ON CONFLICT (floor_id) DO UPDATE SET current_stock_kg = feed_inventory.current_stock_kg + EXCLUDED.current_stock_kg, last_updated = NOW()`, [toFloorId, quantityKg]);
        await client.query(`INSERT INTO feed_transfers (from_floor_id, to_floor_id, transfer_date, quantity_kg, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [fromFloorId, toFloorId, transferDate || new Date().toISOString().split('T')[0], quantityKg, reason, req.user.id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

// === REPORTS ===
app.get('/api/reports', auth, async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    let query = `SELECT r.*, u.name as user_name, b.name as barn_name, f.name as floor_name FROM telemetry_reports r LEFT JOIN users u ON r.user_id = u.id LEFT JOIN barns b ON r.barn_id = b.id LEFT JOIN floors f ON r.floor_id = f.id`;
    const params = []; let conditions = [];
    if (req.isSuperAdmin) { if (req.query.farm_id) { conditions.push(`r.farm_id = $${params.length + 1}`); params.push(req.query.farm_id); } }
    else { conditions.push(`r.farm_id = $${params.length + 1}`); params.push(req.user.farm_id);
        if (req.user.role === 'operator' && req.user.floor_id) { conditions.push(`r.floor_id = $${params.length + 1}`); params.push(req.user.floor_id); }
        else if (req.user.role === 'supervisor' && req.user.barn_id) { conditions.push(`r.barn_id = $${params.length + 1}`); params.push(req.user.barn_id); }
    }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await pool.query(query, params);
    res.json(result.rows);
});

// === SYNC ===
app.post('/api/sync', auth, async (req, res) => {
    const { queue } = req.body;
    if (!queue || !Array.isArray(queue)) return res.status(400).json({ error: 'Invalid queue' });
    const results = [];
    for (const item of queue) {
        try {
            if (item.table === 'telemetry_reports') {
                const p = item.payload;
                const thi = calculateTHI(p.temperature, p.humidity);
                const zone = getTHIZone(p.ageDays, thi);
                const wir = p.feedConsumption > 0 ? p.waterConsumption / p.feedConsumption : 0;
                const riskScore = calculateRisk(p.ageDays, thi, zone, p.mortality || 0, p.population || 0, p.windSpeed || 0, wir);
                const level = getRiskLevel(riskScore);
                const heatStress = zone === 'danger';
                const dwpPhase = getDWPPhase(p.ageDays);
                await pool.query(`INSERT INTO telemetry_reports (farm_id, barn_id, floor_id, user_id, age_days, population, temperature, humidity, mortality, wind_speed, water_consumption, feed_consumption, thi, thi_zone, wir, risk_score, risk_level, heat_stress, dwp_phase)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
                    [req.user.farm_id, p.barnId, p.floorId, req.user.id, p.ageDays, p.population || 0, p.temperature, p.humidity, p.mortality || 0, p.windSpeed || 0, p.waterConsumption || 0, p.feedConsumption || 0, thi, zone, wir, riskScore, level, heatStress, dwpPhase]);
                results.push({ id: item.id, success: true });
            } else if (item.table === 'floor_daily_status') {
                const p = item.payload;
                const popEnd = p.populationStart - (p.mortalityToday || 0) - (p.culledToday || 0) - (p.soldToday || 0);
                await pool.query(`INSERT INTO floor_daily_status (floor_id, report_date, age_days, population_start, mortality_today, culled_today, sold_today, population_end, avg_weight_kg, total_weight_kg, feed_conversion_ratio, notes, cause_category, created_by)
                    VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (floor_id, report_date) DO NOTHING`,
                    [p.floorId, p.ageDays, p.populationStart, p.mortalityToday || 0, p.culledToday || 0, p.soldToday || 0, popEnd, p.avgWeightKg || 0, p.totalWeightKg || 0, p.fcr || 0, p.notes, p.causeCategory, req.user.id]);
                results.push({ id: item.id, success: true });
            } else { results.push({ id: item.id, success: false, error: 'Unknown table' }); }
        } catch (e) { results.push({ id: item.id, success: false, error: e.message }); }
    }
    res.json({ results });
});

// === USERS (CRUD) ===
app.get('/api/users', auth, async (req, res) => {
    if (req.isSuperAdmin) { const result = await pool.query('SELECT id, name, role, farm_id, barn_id, floor_id, is_super_admin, active FROM users ORDER BY created_at DESC'); return res.json(result.rows); }
    const result = await pool.query('SELECT id, name, role, barn_id, floor_id, active FROM users WHERE farm_id = $1', [req.user.farm_id]);
    res.json(result.rows);
});
app.post('/api/users', auth, async (req, res) => {
    if (req.user.role !== 'manager' && !req.isSuperAdmin) return res.status(403).json({ error: 'Hanya Manager' });
    const { name, pin, role, barnId, floorId } = req.body;
    if (!name || !pin || !role) return res.status(400).json({ error: 'Data tidak lengkap' });
    const hash = await bcrypt.hash(pin, 10);
    const farmId = req.isSuperAdmin ? req.body.farmId : req.user.farm_id;
    if (!farmId) return res.status(400).json({ error: 'Farm ID diperlukan' });
    const result = await pool.query('INSERT INTO users (name, pin_hash, role, farm_id, barn_id, floor_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [name, hash, role, farmId, barnId, floorId]);
    res.status(201).json({ id: result.rows[0].id });
});
app.delete('/api/users/:id', auth, async (req, res) => {
    if (req.user.role !== 'manager' && !req.isSuperAdmin) return res.status(403).json({ error: 'Hanya Manager' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// === ADMIN SETUP ===
app.post('/api/admin/setup', async (req, res) => {
    const { name, pin, farmName } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name dan PIN wajib' });
    const hash = await bcrypt.hash(pin, 10);
    let farmId; const farmRes = await pool.query('SELECT id FROM farms LIMIT 1');
    if (farmRes.rows.length === 0) { const newFarm = await pool.query('INSERT INTO farms (name, owner_name) VALUES ($1, $2) RETURNING id', [farmName || 'Hemita Farm', name]); farmId = newFarm.rows[0].id; }
    else { farmId = farmRes.rows[0].id; }
    const existing = await pool.query('SELECT id FROM users WHERE is_super_admin = true LIMIT 1');
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Super Admin sudah ada.' });
    const result = await pool.query('INSERT INTO users (name, pin_hash, role, farm_id, is_super_admin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, hash, 'manager', farmId, true]);
    res.status(201).json({ message: 'Super Admin created!', id: result.rows[0].id });
});

// === GLOBAL STATS ===
app.get('/api/admin/global-stats', auth, async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ error: 'Akses khusus Super Admin' });
    const totalFarms = await pool.query('SELECT COUNT(*) FROM farms');
    const totalBarns = await pool.query('SELECT COUNT(*) FROM barns');
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalReports = await pool.query('SELECT COUNT(*) FROM telemetry_reports');
    const avgRisk = await pool.query('SELECT AVG(risk_score) FROM telemetry_reports');
    const topRisks = await pool.query(`
        SELECT r.*, f.name as farm_name, u.name as user_name, b.name as barn_name, fl.name as floor_name
        FROM telemetry_reports r JOIN farms f ON r.farm_id = f.id LEFT JOIN users u ON r.user_id = u.id LEFT JOIN barns b ON r.barn_id = b.id LEFT JOIN floors fl ON r.floor_id = fl.id
        ORDER BY r.risk_score DESC LIMIT 10
    `);
    res.json({ totalFarms: parseInt(totalFarms.rows[0].count), totalBarns: parseInt(totalBarns.rows[0].count), totalUsers: parseInt(totalUsers.rows[0].count), totalReports: parseInt(totalReports.rows[0].count), avgRisk: parseFloat(avgRisk.rows[0].avg) || 0, topRisks: topRisks.rows });
});

// ============================================================
// GLOBAL ERROR HANDLER (PENANGKAP ERROR TERAKHIR)
// ============================================================
app.use((err, req, res, next) => {
    console.error('❌ Global error handler:', err.stack);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// ============================================================
// START SERVER (UNTUK RENDER)
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 BroilerOS Backend running on port ${PORT}`);
    console.log(`🔒 Security: Helmet, CORS, Rate Limit enabled`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
