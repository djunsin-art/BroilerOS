/**
 * risk-engine.js — CANONICAL RISK ENGINE
 * ============================================================================
 * Single source of truth for THI / zone / risk-score calculation across the
 * whole Hemita Farm-Tech product line: paid BroilerOS tenants AND DWP-99
 * trial/lead usage both call this SAME code path.
 *
 * PROVENANCE: ported verbatim (formula-for-formula, constant-for-constant)
 * from DWP-99 Risk Engine v3.5.0 `cTHI()`, `gTZ()`, `clsTHI()`, `wir_ref()`,
 * `cRisk()` (lines 812-1261 of DWP99-RiskEngine-v3_5_0.html). This is
 * intentional: DWP-99's formula is the more physiologically-grounded one
 * (Lara & Rostagno 2013 / Aviagen Ross 308 2022), so BroilerOS adopts it
 * rather than keeping its own simplified `calcRisk()`, which produced a
 * different number for the same input and never populated a factor
 * breakdown in the UI.
 *
 * RULE GOING FORWARD (mirrors the rule DWP-99 already enforces around its
 * DataStore): no other file in either BroilerOS or DWP-99 should reimplement
 * THI/zone/risk math. If the formula needs to change, it changes HERE, and
 * both the DWP-99 frontend (offline fallback copy) and BroilerOS backend
 * (this file) get bumped together — see VERSION below.
 *
 * ---------------------------------------------------------------------------
 * INTEGRATION (BroilerOS backend, Node/Express + pg):
 *
 *   const { createRiskRouter } = require('./risk-engine');
 *   app.use('/api', createRiskRouter({ pool }));   // pool = your existing pg Pool
 *
 * This adds two endpoints:
 *   POST /api/risk/calculate        — for paid tenants (existing auth/ownership
 *                                      middleware should wrap this route same
 *                                      as your other /api/floors, /api/barns
 *                                      routes; not duplicated here since your
 *                                      auth pattern isn't in this file)
 *   POST /api/dwp99/trial/telemetry — for DWP-99 trial/lead ingestion, writes
 *                                      into the isolated dwp99_trial schema
 *                                      (see neon-dwp99-trial-schema.sql).
 *                                      Deliberately NOT behind tenant
 *                                      ownership guards — these rows are not
 *                                      tenant data.
 * ---------------------------------------------------------------------------
 */

'use strict';

const VERSION = '1.0.0'; // bump together with DWP-99 frontend's canonical-copy version tag

// ----------------------------------------------------------------------------
// TEMPERATURE-HUMIDITY ZONES (age-dependent)
// Source: DWP-99 v3.5.0 `TZ` constant. Comfort THI decreases with age —
// physiologically correct (DOC needs heat, finisher needs cool).
// ----------------------------------------------------------------------------
const TZ = [
  { phase: 'Starter Awal',   min: 0,  max: 7,  comfort: 92, alert: 95, suhu: '30–33°C' },
  { phase: 'Starter Akhir',  min: 8,  max: 14, comfort: 89, alert: 93, suhu: '28–30°C' },
  { phase: 'Grower Awal',    min: 15, max: 21, comfort: 86, alert: 90, suhu: '26–28°C' },
  { phase: 'Grower Akhir',   min: 22, max: 28, comfort: 84, alert: 88, suhu: '24–26°C' },
  { phase: 'Finisher Awal',  min: 29, max: 35, comfort: 81, alert: 85, suhu: '22–24°C' },
  { phase: 'Finisher Akhir', min: 36, max: 60, comfort: 79, alert: 83, suhu: '≤22°C' },
];

/** Temperature-Humidity Index. Identical to DWP-99 `cTHI()`. */
function cTHI(t, rh) {
  const tf = 1.8 * t + 32;
  return +(tf - (0.55 - 0.0055 * rh) * (tf - 58)).toFixed(1);
}

/** Age-appropriate comfort/alert zone. Identical to DWP-99 `gTZ()`. */
function gTZ(age) {
  return TZ.find((z) => age >= z.min && age <= z.max) || TZ[TZ.length - 1];
}

/** THI classification within a zone. Identical to DWP-99 `clsTHI()`. */
function clsTHI(thi, z) {
  if (thi <= z.comfort) return 'comfort';
  if (thi <= z.alert) return 'alert';
  return 'danger';
}

/** WIR (Water Intake Ratio) age-referenced thresholds. Identical to DWP-99 `wir_ref()`. */
function wirRef(age) {
  if (age <= 7) return { lo: 1.5, hi: 2.0, al: 2.5 };
  if (age <= 14) return { lo: 1.7, hi: 2.2, al: 2.7 };
  if (age <= 21) return { lo: 1.8, hi: 2.3, al: 2.8 };
  if (age <= 28) return { lo: 1.9, hi: 2.5, al: 3.0 };
  if (age <= 35) return { lo: 2.0, hi: 2.8, al: 3.2 };
  return { lo: 2.0, hi: 3.0, al: 3.5 };
}

/**
 * 5-factor named risk breakdown. Identical formula/weights/caps to DWP-99
 * `cRisk()`: Heat Stress (max 40), Mortalitas (max 30), Ventilasi (max 15),
 * WIR Ratio (max 10), Kerentanan Umur (max 5) — total capped at 100.
 *
 * @param {{age:number, thi:number, z:object, mort:number, pop:number, wind:number, wir:number}} input
 * @returns {{total:number, level:string, params:Array<{name:string,v:number,max:number,severity:string}>}}
 */
function cRisk({ age, thi, z, mort, pop, wind, wir }) {
  let ts = 0;
  if (thi <= z.comfort) ts = Math.max(0, (thi - z.comfort + 10) * 1.5);
  else if (thi <= z.alert) ts = 20 + ((thi - z.comfort) / (z.alert - z.comfort)) * 15;
  else ts = 35 + Math.min(5, (thi - z.alert) * 1.5);
  ts = Math.min(40, Math.max(0, ts));

  const mr = pop > 0 ? (mort / pop) * 100 : 0;
  const ms = mr < 0.05 ? 0 : mr < 0.1 ? 8 : mr < 0.2 ? 16 : mr < 0.5 ? 22 : 30;

  const vs = wind < 1 ? 15 : wind < 1.5 ? 10 : wind < 2 ? 5 : 0;

  const ref = wirRef(age);
  const ws = wir > 0 ? (wir > ref.al ? 10 : wir > ref.hi ? 6 : wir < ref.lo ? 4 : 0) : 0;

  const as2 = age >= 14 && age <= 28 ? 5 : age >= 7 && age <= 35 ? 3 : 1;

  const total = Math.min(100, Math.round(ts + ms + vs + ws + as2));

  return {
    total,
    level: riskLevel(total).label,
    params: [
      { name: 'Heat Stress (THI)',  v: Math.round(ts), max: 40, severity: thi > z.alert ? 'danger' : thi > z.comfort ? 'warn' : 'safe' },
      { name: 'Mortalitas',         v: Math.round(ms), max: 30, severity: ms > 15 ? 'danger' : ms > 8 ? 'warn' : 'safe' },
      { name: 'Ventilasi',          v: Math.round(vs), max: 15, severity: vs > 8 ? 'warn' : 'safe' },
      { name: 'WIR Ratio',          v: Math.round(ws), max: 10, severity: ws > 6 ? 'danger' : ws > 3 ? 'warn' : 'safe' },
      { name: 'Kerentanan Umur',    v: Math.round(as2), max: 5,  severity: as2 >= 5 ? 'warn' : 'safe' },
    ],
  };
}

/** Risk level label. Identical to DWP-99 `gRL()`. */
function riskLevel(s) {
  if (s < 25) return { label: 'RENDAH' };
  if (s < 50) return { label: 'SEDANG' };
  if (s < 75) return { label: 'TINGGI' };
  return { label: 'KRITIS' };
}

/**
 * One-call convenience wrapper: raw sensor inputs in, full breakdown out.
 * This is what both HTTP handlers below call.
 */
function evaluate({ ageDays, population, temperature, humidity, mortality, windSpeed, waterLiters, feedKg }) {
  const age = Number(ageDays) || 0;
  const pop = Number(population) || 0;
  const temp = Number(temperature);
  const hum = Number(humidity);
  const mort = Number(mortality) || 0;
  const wind = windSpeed === undefined || windSpeed === null ? 2 : Number(windSpeed);
  const feed = Number(feedKg) || 0;
  const water = Number(waterLiters) || 0;

  const thi = cTHI(temp, hum);
  const z = gTZ(age);
  const cls = clsTHI(thi, z);
  const wir = feed > 0 ? +(water / feed).toFixed(2) : 0;
  const risk = cRisk({ age, thi, z, mort, pop, wind, wir });

  return {
    engineVersion: VERSION,
    thi,
    thiZone: cls,
    phase: z.phase,
    wir,
    risk: risk.total,
    riskLevel: risk.level,
    breakdown: risk.params,
  };
}

// ----------------------------------------------------------------------------
// EXPRESS ROUTER
// ----------------------------------------------------------------------------
function createRiskRouter({ pool }) {
  const express = require('express');
  const router = express.Router();

  /**
   * POST /api/risk/calculate
   * Paid-tenant use. Wrap this route with your existing auth + ownership
   * guard middleware where you mount it (same pattern as your other
   * /api/floors/:id and /api/barns/:id routes) — this file intentionally
   * does not assume your auth middleware's shape.
   */
  router.post('/risk/calculate', (req, res) => {
    try {
      const result = evaluate(req.body || {});
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: 'invalid_input', message: e.message });
    }
  });

  /**
   * POST /api/dwp99/trial/telemetry
   * DWP-99 trial/lead ingestion. NOT behind tenant ownership guards — these
   * rows belong to the isolated dwp99_trial schema, never the tenant tables.
   * Body: { leadId, deviceId, bi, fi, unitLabel, ageDays, population,
   *         temperature, humidity, mortality, windSpeed, waterLiters, feedKg,
   *         recordedAt }
   * leadId is optional on first call — if absent, a new lead row is created
   * from deviceId (see neon-dwp99-trial-schema.sql for the upsert contract).
   */
  router.post('/dwp99/trial/telemetry', async (req, res) => {
    const b = req.body || {};
    if (!b.deviceId) {
      return res.status(400).json({ error: 'missing_device_id' });
    }
    try {
      const result = evaluate(b);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Ensure a lead row exists for this device (idempotent).
        const leadRes = await client.query(
          `INSERT INTO dwp99_trial.leads (device_id, display_name, phone_number, farm_label, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, now(), now())
           ON CONFLICT (device_id)
           DO UPDATE SET last_seen_at = now(),
                         display_name = COALESCE(EXCLUDED.display_name, dwp99_trial.leads.display_name),
                         phone_number = COALESCE(EXCLUDED.phone_number, dwp99_trial.leads.phone_number)
           RETURNING id`,
          [b.deviceId, b.displayName || null, b.phoneNumber || null, b.farmLabel || null]
        );
        const leadId = leadRes.rows[0].id;

        await client.query(
          `INSERT INTO dwp99_trial.trial_records
             (lead_id, unit_label, age_days, population, temperature, humidity, mortality, wind_speed,
              water_liters, feed_kg, thi, thi_zone, risk_score, risk_level, risk_breakdown,
              engine_version, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17, now()))`,
          [
            leadId, b.unitLabel || null, b.ageDays || 0, b.population || 0, b.temperature, b.humidity,
            b.mortality || 0, b.windSpeed ?? 2, b.waterLiters || 0, b.feedKg || 0,
            result.thi, result.thiZone, result.risk, result.riskLevel,
            JSON.stringify(result.breakdown), result.engineVersion, b.recordedAt || null,
          ]
        );

        await client.query('COMMIT');
        res.json({ ok: true, leadId, ...result });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  /**
   * GET /api/dwp99/trial/leads
   * Powers the "Prospek DWP-99" panel in BroilerOS's Global Monitor. Reads
   * from the dwp99_trial.lead_readiness view (see
   * neon-dwp99-trial-schema.sql) — ungraduated leads only, ranked by report
   * volume. Wrap this route with your super-admin/client-admin auth
   * middleware where you mount it, same as /api/admin/*.
   */
  router.get('/dwp99/trial/leads', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, device_id, display_name, phone_number, farm_label,
                first_seen_at, last_seen_at, total_reports, high_risk_reports,
                distinct_units_reported, last_report_at, high_risk_pct
         FROM dwp99_trial.lead_readiness
         ORDER BY total_reports DESC
         LIMIT 200`
      );
      res.json({ leads: result.rows });
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  return router;
}

module.exports = {
  VERSION,
  TZ,
  cTHI,
  gTZ,
  clsTHI,
  wirRef,
  cRisk,
  riskLevel,
  evaluate,
  createRiskRouter,
};
