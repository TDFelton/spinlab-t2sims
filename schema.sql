-- =====================================================================
--  NMR Relaxation Database  ·  schema version 3
-- =====================================================================
--  Units (stored values are always in these units):
--    T1, T2, correlation times ........ s
--    relaxation rates (R1, R2) ......... 1/s
--    diffusion coefficients ............ m^2/s
--    temperature ....................... K
--    Hansen solubility parameters ...... MPa^0.5
--    molar mass ........................ g/mol
--    density ........................... g/cm^3
--    echo times ........................ s  (comma-separated list)
--    simulation length ................. ns ;  timestep ... fs
--  Dates are ISO 8601 text: YYYY-MM-DD.
--
--  Mixtures are binary. A record names compound A, optionally compound B,
--  and x_a = mole fraction of A (x_b = 1 - x_a). A pure liquid has no
--  compound B and x_a = 1. A record that names B but has x_a = 0 or 1
--  (an endpoint of a mole-fraction sweep) is also treated as pure.
--
--  Compounds are identified by CAS number (1st), SMILES (2nd) and name
--  (3rd). Each is optional, but every compound needs at least one, and each
--  is unique. Views show a compound by its name, else its CAS, else SMILES.
--  other_names holds alternative names (separated by semicolons) that imports
--  recognise like the name, e.g. after two duplicate compounds are merged.
--  Version 2 made the name optional; version 3 (this file) added other_names.
--  The web app upgrades older databases automatically.
--
--  NOTE: SQLite enforces foreign keys only after  PRAGMA foreign_keys = ON;
--  which must be run on every new connection.
-- =====================================================================

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------
--  PHYSICAL CONSTANTS: one row per pure compound
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compounds (
  compound_id    INTEGER PRIMARY KEY,
  cas            TEXT UNIQUE CHECK (cas IS NULL OR trim(cas) <> ''),            -- identifier 1
  smiles         TEXT CHECK (smiles IS NULL OR trim(smiles) <> ''),            -- identifier 2 (unique: trigger below)
  name           TEXT UNIQUE COLLATE NOCASE CHECK (name IS NULL OR trim(name) <> ''),  -- identifier 3
  other_names    TEXT,   -- alternative names, separated by semicolons; imports match them like the name
  formula        TEXT,
  mw_g_mol       REAL CHECK (mw_g_mol IS NULL OR mw_g_mol > 0),
  density_g_cm3  REAL CHECK (density_g_cm3 IS NULL OR density_g_cm3 > 0),
  hsp_d_mpa05    REAL,   -- Hansen dispersion parameter, delta_D
  hsp_p_mpa05    REAL,   -- Hansen polar parameter, delta_P
  hsp_h_mpa05    REAL,   -- Hansen hydrogen-bonding parameter, delta_H
  source         TEXT,   -- where the constants came from
  comments       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT,
  CHECK (cas IS NOT NULL OR smiles IS NOT NULL OR name IS NOT NULL)
);

-- ---------------------------------------------------------------------
--  EXPERIMENTAL: one row per NMR measurement
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id       INTEGER PRIMARY KEY,
  compound_a_id       INTEGER NOT NULL REFERENCES compounds(compound_id) ON DELETE RESTRICT,
  compound_b_id       INTEGER REFERENCES compounds(compound_id) ON DELETE RESTRICT,
  x_a                 REAL NOT NULL DEFAULT 1.0 CHECK (x_a >= 0 AND x_a <= 1),
  temperature_k       REAL CHECK (temperature_k IS NULL OR temperature_k > 0),
  magnet              TEXT,
  pulse_sequence      TEXT,
  echo_times_s        TEXT,
  degassed            INTEGER CHECK (degassed IS NULL OR degassed IN (0, 1)),
  n_scans             INTEGER CHECK (n_scans IS NULL OR n_scans > 0),
  t2_s                REAL CHECK (t2_s IS NULL OR t2_s > 0),
  t2_err_s            REAL CHECK (t2_err_s IS NULL OR t2_err_s >= 0),
  diffusion_m2_s      REAL CHECK (diffusion_m2_s IS NULL OR diffusion_m2_s > 0),
  diffusion_err_m2_s  REAL CHECK (diffusion_err_m2_s IS NULL OR diffusion_err_m2_s >= 0),
  location            TEXT,   -- where the measurement was made (lab / instrument)
  date                TEXT CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  user_name           TEXT,
  comments            TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT,
  CHECK (compound_b_id IS NOT NULL OR x_a = 1.0),
  CHECK (compound_b_id IS NULL OR compound_b_id <> compound_a_id)
);

-- ---------------------------------------------------------------------
--  SIMULATED: one row per MD simulation (setup + where it lives).
--  Computed numbers (T2, D, ...) go in processed_results.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulations (
  simulation_id   INTEGER PRIMARY KEY,
  compound_a_id   INTEGER NOT NULL REFERENCES compounds(compound_id) ON DELETE RESTRICT,
  compound_b_id   INTEGER REFERENCES compounds(compound_id) ON DELETE RESTRICT,
  x_a             REAL NOT NULL DEFAULT 1.0 CHECK (x_a >= 0 AND x_a <= 1),
  temperature_k   REAL CHECK (temperature_k IS NULL OR temperature_k > 0),
  n_molecules_a   INTEGER CHECK (n_molecules_a IS NULL OR n_molecules_a >= 0),
  n_molecules_b   INTEGER CHECK (n_molecules_b IS NULL OR n_molecules_b >= 0),
  force_field     TEXT,
  software        TEXT,
  production_ns   REAL CHECK (production_ns IS NULL OR production_ns > 0),
  timestep_fs     REAL CHECK (timestep_fs IS NULL OR timestep_fs > 0),
  location        TEXT,   -- where it ran / lives (cluster, node, directory)
  date            TEXT CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  user_name       TEXT,
  comments        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT,
  CHECK (compound_b_id IS NOT NULL OR x_a = 1.0),
  CHECK (compound_b_id IS NULL OR compound_b_id <> compound_a_id)
);

-- ---------------------------------------------------------------------
--  PROCESSED DATA: every number the analysis scripts compute, one per row
--  ("long" / tidy format), so new kinds of results need no schema change.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quantities (
  quantity     TEXT PRIMARY KEY CHECK (trim(quantity) <> ''),
  unit         TEXT NOT NULL,
  description  TEXT
);

INSERT OR IGNORE INTO quantities (quantity, unit, description) VALUES
  ('T1',    's',     'Longitudinal (spin-lattice) relaxation time'),
  ('T2',    's',     'Transverse (spin-spin) relaxation time'),
  ('R1',    '1/s',   'Longitudinal relaxation rate, 1/T1'),
  ('R2',    '1/s',   'Transverse relaxation rate, 1/T2'),
  ('D',     'm^2/s', 'Self-diffusion coefficient'),
  ('tau_c', 's',     'Rotational / dipolar correlation time');

CREATE TABLE IF NOT EXISTS processed_results (
  result_id            INTEGER PRIMARY KEY,
  simulation_id        INTEGER NOT NULL REFERENCES simulations(simulation_id) ON DELETE CASCADE,
  quantity             TEXT NOT NULL REFERENCES quantities(quantity) ON UPDATE CASCADE ON DELETE RESTRICT,
  species_compound_id  INTEGER REFERENCES compounds(compound_id) ON DELETE RESTRICT,  -- NULL = whole sample
  contribution         TEXT NOT NULL DEFAULT 'total' CHECK (trim(contribution) <> ''),  -- total / intra / inter / ...
  method               TEXT,   -- e.g. ensemble single-exponential fit, harmonic mean of rates
  value                REAL NOT NULL,
  uncertainty          REAL CHECK (uncertainty IS NULL OR uncertainty >= 0),
  script               TEXT,   -- which analysis script produced it (inter / intra / results ...)
  source_path          TEXT,   -- output file the number was read from
  date                 TEXT CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  comments             TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at           TEXT
);

-- ---------------------------------------------------------------------
--  RAW DATA: where the raw files live (paths or URLs), linked to at most
--  one experiment or simulation. The files themselves are not stored here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_data (
  raw_id         INTEGER PRIMARY KEY,
  experiment_id  INTEGER REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  simulation_id  INTEGER REFERENCES simulations(simulation_id) ON DELETE CASCADE,
  path           TEXT NOT NULL CHECK (trim(path) <> ''),
  file_type      TEXT,
  description    TEXT,
  comments       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT,
  CHECK (experiment_id IS NULL OR simulation_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_exp_a      ON experiments(compound_a_id);
CREATE INDEX IF NOT EXISTS idx_exp_b      ON experiments(compound_b_id);
CREATE INDEX IF NOT EXISTS idx_sim_a      ON simulations(compound_a_id);
CREATE INDEX IF NOT EXISTS idx_sim_b      ON simulations(compound_b_id);
CREATE INDEX IF NOT EXISTS idx_proc_sim   ON processed_results(simulation_id);
CREATE INDEX IF NOT EXISTS idx_proc_qty   ON processed_results(quantity);
CREATE INDEX IF NOT EXISTS idx_raw_exp    ON raw_data(experiment_id);
CREATE INDEX IF NOT EXISTS idx_raw_sim    ON raw_data(simulation_id);
CREATE INDEX IF NOT EXISTS idx_cmp_smiles ON compounds(smiles);

-- ---------------------------------------------------------------------
--  TRIGGERS: integrity rules that CHECK constraints cannot express
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS processed_species_ins
BEFORE INSERT ON processed_results
WHEN NEW.species_compound_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM simulations s
  WHERE s.simulation_id = NEW.simulation_id
    AND NEW.species_compound_id IN (s.compound_a_id, s.compound_b_id))
BEGIN
  SELECT RAISE(ABORT, 'Species must be compound A or compound B of the linked simulation');
END;

CREATE TRIGGER IF NOT EXISTS processed_species_upd
BEFORE UPDATE OF species_compound_id, simulation_id ON processed_results
WHEN NEW.species_compound_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM simulations s
  WHERE s.simulation_id = NEW.simulation_id
    AND NEW.species_compound_id IN (s.compound_a_id, s.compound_b_id))
BEGIN
  SELECT RAISE(ABORT, 'Species must be compound A or compound B of the linked simulation');
END;

CREATE TRIGGER IF NOT EXISTS simulation_compounds_upd
BEFORE UPDATE OF compound_a_id, compound_b_id ON simulations
WHEN EXISTS (
  SELECT 1 FROM processed_results pr
  WHERE pr.simulation_id = NEW.simulation_id
    AND pr.species_compound_id IS NOT NULL
    AND pr.species_compound_id NOT IN (NEW.compound_a_id, coalesce(NEW.compound_b_id, -1)))
BEGIN
  SELECT RAISE(ABORT, 'Processed results of this simulation refer to a compound you are removing; edit them first');
END;

-- SMILES are unique like CAS numbers and names. A trigger rather than a
-- UNIQUE constraint, so upgrading an older file never fails on duplicates
-- already in it; new duplicates are refused, while compounds that already share
-- a SMILES can still be edited. Exact text (SMILES is case-sensitive).
CREATE TRIGGER IF NOT EXISTS compounds_smiles_unique_ins
BEFORE INSERT ON compounds
WHEN NEW.smiles IS NOT NULL AND EXISTS (SELECT 1 FROM compounds WHERE smiles = NEW.smiles)
BEGIN
  SELECT RAISE(ABORT, 'Another compound already has this SMILES');
END;

CREATE TRIGGER IF NOT EXISTS compounds_smiles_unique_upd
BEFORE UPDATE OF smiles ON compounds
WHEN NEW.smiles IS NOT NULL AND NEW.smiles IS NOT OLD.smiles AND EXISTS (
  SELECT 1 FROM compounds WHERE smiles = NEW.smiles AND compound_id <> NEW.compound_id)
BEGIN
  SELECT RAISE(ABORT, 'Another compound already has this SMILES');
END;

CREATE TRIGGER IF NOT EXISTS compounds_touch AFTER UPDATE ON compounds
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE compounds SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE compound_id = NEW.compound_id; END;

CREATE TRIGGER IF NOT EXISTS experiments_touch AFTER UPDATE ON experiments
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE experiments SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE experiment_id = NEW.experiment_id; END;

CREATE TRIGGER IF NOT EXISTS simulations_touch AFTER UPDATE ON simulations
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE simulations SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE simulation_id = NEW.simulation_id; END;

CREATE TRIGGER IF NOT EXISTS processed_touch AFTER UPDATE ON processed_results
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE processed_results SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE result_id = NEW.result_id; END;

CREATE TRIGGER IF NOT EXISTS raw_touch AFTER UPDATE ON raw_data
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE raw_data SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE raw_id = NEW.raw_id; END;

-- ---------------------------------------------------------------------
--  VIEWS: read-only, computed on the fly (nothing below is stored)
-- ---------------------------------------------------------------------

-- Compounds plus derived constants.
--   label         name, else CAS, else SMILES (how compounds are shown)
--   molar volume  V_m = M / rho                       (cm^3/mol)
--   Hansen total  delta_t = sqrt(dD^2 + dP^2 + dH^2)   (MPa^0.5)
CREATE VIEW IF NOT EXISTS v_compounds AS
SELECT coalesce(c.name, c.cas, c.smiles) AS label, c.*,
  CASE WHEN c.mw_g_mol IS NOT NULL AND c.density_g_cm3 IS NOT NULL
       THEN c.mw_g_mol / c.density_g_cm3 END AS molar_volume_cm3_mol,
  CASE WHEN c.hsp_d_mpa05 IS NOT NULL AND c.hsp_p_mpa05 IS NOT NULL AND c.hsp_h_mpa05 IS NOT NULL
       THEN sqrt(c.hsp_d_mpa05*c.hsp_d_mpa05 + c.hsp_p_mpa05*c.hsp_p_mpa05 + c.hsp_h_mpa05*c.hsp_h_mpa05)
  END AS hsp_total_mpa05
FROM compounds c;

-- Experiments with compound names and pure/mixture classification.
CREATE VIEW IF NOT EXISTS v_experiments AS
SELECT e.experiment_id,
  CASE WHEN e.compound_b_id IS NULL OR e.x_a >= 1 - 1e-9 OR e.x_a <= 1e-9 THEN 'pure' ELSE 'mixture' END AS sample_type,
  coalesce(ca.name, ca.cas, ca.smiles) AS compound_a, coalesce(cb.name, cb.cas, cb.smiles) AS compound_b, e.x_a,
  CASE WHEN e.compound_b_id IS NULL THEN NULL ELSE round(1.0 - e.x_a, 10) END AS x_b,
  e.temperature_k, e.magnet, e.pulse_sequence, e.echo_times_s, e.degassed, e.n_scans,
  e.t2_s, e.t2_err_s, e.diffusion_m2_s, e.diffusion_err_m2_s,
  e.location, e.date, e.user_name, e.comments,
  (SELECT count(*) FROM raw_data r WHERE r.experiment_id = e.experiment_id) AS n_raw_files,
  e.compound_a_id, e.compound_b_id, e.created_at, e.updated_at,
  ca.cas AS cas_a, cb.cas AS cas_b
FROM experiments e
JOIN compounds ca ON ca.compound_id = e.compound_a_id
LEFT JOIN compounds cb ON cb.compound_id = e.compound_b_id;

-- Simulations with names, classification and a summary of whole-sample,
-- total T2 and D values from processed_results (one entry per method).
CREATE VIEW IF NOT EXISTS v_simulations AS
SELECT s.simulation_id,
  CASE WHEN s.compound_b_id IS NULL OR s.x_a >= 1 - 1e-9 OR s.x_a <= 1e-9 THEN 'pure' ELSE 'mixture' END AS sample_type,
  coalesce(ca.name, ca.cas, ca.smiles) AS compound_a, coalesce(cb.name, cb.cas, cb.smiles) AS compound_b, s.x_a,
  CASE WHEN s.compound_b_id IS NULL THEN NULL ELSE round(1.0 - s.x_a, 10) END AS x_b,
  s.temperature_k, s.n_molecules_a, s.n_molecules_b, s.force_field, s.software,
  s.production_ns, s.timestep_fs,
  (SELECT group_concat(printf('%.4g', pr.value) || coalesce(' [' || pr.method || ']', ''), '; ')
     FROM processed_results pr
    WHERE pr.simulation_id = s.simulation_id AND pr.quantity = 'T2'
      AND pr.contribution = 'total' AND pr.species_compound_id IS NULL) AS t2_total_s,
  (SELECT group_concat(printf('%.4g', pr.value) || coalesce(' [' || pr.method || ']', ''), '; ')
     FROM processed_results pr
    WHERE pr.simulation_id = s.simulation_id AND pr.quantity = 'D'
      AND pr.contribution = 'total' AND pr.species_compound_id IS NULL) AS d_total_m2_s,
  (SELECT count(*) FROM processed_results pr WHERE pr.simulation_id = s.simulation_id) AS n_results,
  (SELECT count(*) FROM raw_data r WHERE r.simulation_id = s.simulation_id) AS n_raw_files,
  s.location, s.date, s.user_name, s.comments,
  s.compound_a_id, s.compound_b_id, s.created_at, s.updated_at,
  ca.cas AS cas_a, cb.cas AS cas_b
FROM simulations s
JOIN compounds ca ON ca.compound_id = s.compound_a_id
LEFT JOIN compounds cb ON cb.compound_id = s.compound_b_id;

-- Processed results with the simulation's sample and the quantity's unit.
CREATE VIEW IF NOT EXISTS v_processed AS
SELECT pr.result_id, pr.simulation_id, vs.sample_type,
  vs.compound_a, vs.compound_b, vs.x_a, vs.temperature_k,
  pr.quantity, coalesce(sp.name, sp.cas, sp.smiles, 'whole sample') AS species, pr.contribution, pr.method,
  pr.value, pr.uncertainty, q.unit,
  pr.script, pr.source_path, pr.date, pr.comments,
  pr.species_compound_id, pr.created_at, pr.updated_at
FROM processed_results pr
JOIN v_simulations vs ON vs.simulation_id = pr.simulation_id
JOIN quantities q ON q.quantity = pr.quantity
LEFT JOIN compounds sp ON sp.compound_id = pr.species_compound_id;

-- Raw-data locations with a readable label for the linked record.
CREATE VIEW IF NOT EXISTS v_raw_data AS
SELECT r.raw_id,
  CASE WHEN r.experiment_id IS NOT NULL THEN 'experimental'
       WHEN r.simulation_id IS NOT NULL THEN 'simulated' ELSE 'unlinked' END AS linked_to,
  coalesce(r.experiment_id, r.simulation_id) AS record_id,
  coalesce(ve.compound_a, vs.compound_a) AS compound_a,
  coalesce(ve.compound_b, vs.compound_b) AS compound_b,
  coalesce(ve.x_a, vs.x_a) AS x_a,
  coalesce(ve.sample_type, vs.sample_type) AS sample_type,
  r.path, r.file_type, r.description, r.comments,
  r.experiment_id, r.simulation_id, r.created_at, r.updated_at
FROM raw_data r
LEFT JOIN v_experiments ve ON ve.experiment_id = r.experiment_id
LEFT JOIN v_simulations vs ON vs.simulation_id = r.simulation_id;

-- One catalogue of every record, with an explicit exp-vs-sim column.
CREATE VIEW IF NOT EXISTS v_all_records AS
SELECT 'experimental' AS kind, experiment_id AS record_id, sample_type, compound_a, compound_b, x_a,
       temperature_k, location, date, user_name, n_raw_files, comments
  FROM v_experiments
UNION ALL
SELECT 'simulated', simulation_id, sample_type, compound_a, compound_b, x_a,
       temperature_k, location, date, user_name, n_raw_files, comments
  FROM v_simulations;

-- Hansen parameters of each binary mixture that appears in the data.
-- Mixing rule: volume-fraction-weighted average of the pure-component
-- values, with ideal mixing (no excess volume):
--   phi_A = x_A V_A / (x_A V_A + x_B V_B),   delta_mix = phi_A delta_A + phi_B delta_B
-- Needs molar mass and density for both compounds; otherwise NULL.
CREATE VIEW IF NOT EXISTS v_mixture_hsp AS
WITH samples AS (
  SELECT compound_a_id AS a, compound_b_id AS b, x_a AS x FROM experiments
   WHERE compound_b_id IS NOT NULL AND x_a > 1e-9 AND x_a < 1 - 1e-9
  UNION
  SELECT compound_a_id, compound_b_id, x_a FROM simulations
   WHERE compound_b_id IS NOT NULL AND x_a > 1e-9 AND x_a < 1 - 1e-9
), vol AS (
  SELECT s.a, s.b, s.x, coalesce(ca.name, ca.cas, ca.smiles) AS na, coalesce(cb.name, cb.cas, cb.smiles) AS nb,
         ca.mw_g_mol / ca.density_g_cm3 AS va, cb.mw_g_mol / cb.density_g_cm3 AS vb,
         ca.hsp_d_mpa05 AS da, ca.hsp_p_mpa05 AS pa, ca.hsp_h_mpa05 AS ha,
         cb.hsp_d_mpa05 AS db, cb.hsp_p_mpa05 AS pb, cb.hsp_h_mpa05 AS hb
    FROM samples s
    JOIN compounds ca ON ca.compound_id = s.a
    JOIN compounds cb ON cb.compound_id = s.b
), phi AS (
  SELECT *, (x * va) / (x * va + (1 - x) * vb) AS phi_a FROM vol
)
SELECT na AS compound_a, nb AS compound_b, x AS x_a, round(1 - x, 10) AS x_b,
       phi_a AS volume_fraction_a,
       phi_a * da + (1 - phi_a) * db AS hsp_d_mpa05,
       phi_a * pa + (1 - phi_a) * pb AS hsp_p_mpa05,
       phi_a * ha + (1 - phi_a) * hb AS hsp_h_mpa05,
       (SELECT count(*) FROM experiments e WHERE e.compound_a_id = a AND e.compound_b_id = b AND e.x_a = x) AS n_experiments,
       (SELECT count(*) FROM simulations s2 WHERE s2.compound_a_id = a AND s2.compound_b_id = b AND s2.x_a = x) AS n_simulations
  FROM phi;

-- Simulation vs experiment, paired automatically.
-- A pair is made when: same compounds (order-insensitive), mole fractions
-- within meta.match_tol_x, temperatures within meta.match_tol_t_k. The
-- simulated value is a whole-sample, 'total' processed result for T2 or D
-- (one comparison row per method).
--   ratio    = sim / exp
--   pct_diff = 100 (sim - exp) / exp
--   z_score  = (sim - exp) / sqrt(u_sim^2 + u_exp^2)   (only when both
--              uncertainties are given; assumes they are independent)
CREATE VIEW IF NOT EXISTS v_sim_vs_exp AS
WITH tol AS (
  SELECT coalesce((SELECT CAST(value AS REAL) FROM meta WHERE key = 'match_tol_x'), 0.01)  AS tx,
         coalesce((SELECT CAST(value AS REAL) FROM meta WHERE key = 'match_tol_t_k'), 1.0) AS tt
), sim_c AS (
  SELECT s.simulation_id, s.temperature_k AS t,
    CASE WHEN s.compound_b_id IS NULL OR s.x_a >= 1 - 1e-9 THEN s.compound_a_id
         WHEN s.x_a <= 1e-9 THEN s.compound_b_id
         WHEN s.compound_a_id < s.compound_b_id THEN s.compound_a_id ELSE s.compound_b_id END AS p,
    CASE WHEN s.compound_b_id IS NULL OR s.x_a >= 1 - 1e-9 OR s.x_a <= 1e-9 THEN NULL
         WHEN s.compound_a_id < s.compound_b_id THEN s.compound_b_id ELSE s.compound_a_id END AS q,
    CASE WHEN s.compound_b_id IS NULL OR s.x_a >= 1 - 1e-9 OR s.x_a <= 1e-9 THEN 1.0
         WHEN s.compound_a_id < s.compound_b_id THEN s.x_a ELSE 1.0 - s.x_a END AS xp
  FROM simulations s
), sim_v AS (
  SELECT c.*, pr.result_id, pr.quantity, pr.method, pr.value, pr.uncertainty
    FROM sim_c c
    JOIN processed_results pr ON pr.simulation_id = c.simulation_id
   WHERE pr.contribution = 'total' AND pr.quantity IN ('T2', 'D')
     AND (pr.species_compound_id IS NULL OR (c.q IS NULL AND pr.species_compound_id = c.p))
), exp_c AS (
  SELECT e.*,
    CASE WHEN e.compound_b_id IS NULL OR e.x_a >= 1 - 1e-9 THEN e.compound_a_id
         WHEN e.x_a <= 1e-9 THEN e.compound_b_id
         WHEN e.compound_a_id < e.compound_b_id THEN e.compound_a_id ELSE e.compound_b_id END AS p,
    CASE WHEN e.compound_b_id IS NULL OR e.x_a >= 1 - 1e-9 OR e.x_a <= 1e-9 THEN NULL
         WHEN e.compound_a_id < e.compound_b_id THEN e.compound_b_id ELSE e.compound_a_id END AS q,
    CASE WHEN e.compound_b_id IS NULL OR e.x_a >= 1 - 1e-9 OR e.x_a <= 1e-9 THEN 1.0
         WHEN e.compound_a_id < e.compound_b_id THEN e.x_a ELSE 1.0 - e.x_a END AS xp
  FROM experiments e
), exp_v AS (
  SELECT experiment_id, p, q, xp, temperature_k AS t, degassed, magnet, pulse_sequence,
         'T2' AS quantity, t2_s AS value, t2_err_s AS uncertainty
    FROM exp_c WHERE t2_s IS NOT NULL
  UNION ALL
  SELECT experiment_id, p, q, xp, temperature_k, degassed, magnet, pulse_sequence,
         'D', diffusion_m2_s, diffusion_err_m2_s
    FROM exp_c WHERE diffusion_m2_s IS NOT NULL
)
SELECT
  CASE WHEN sv.q IS NULL THEN 'pure' ELSE 'mixture' END AS sample_type,
  sv.quantity, qu.unit,
  coalesce(cp.name, cp.cas, cp.smiles) AS compound_1, coalesce(cq.name, cq.cas, cq.smiles) AS compound_2, round(sv.xp, 10) AS x_1,
  round(ev.xp, 10) AS x_1_exp,
  sv.t AS temperature_sim_k, ev.t AS temperature_exp_k,
  sv.method AS sim_method,
  sv.value AS sim_value, sv.uncertainty AS sim_uncertainty,
  ev.value AS exp_value, ev.uncertainty AS exp_uncertainty,
  sv.value / ev.value AS ratio,
  100.0 * (sv.value - ev.value) / ev.value AS pct_diff,
  CASE WHEN sv.uncertainty IS NOT NULL AND ev.uncertainty IS NOT NULL
        AND (sv.uncertainty > 0 OR ev.uncertainty > 0)
       THEN (sv.value - ev.value) / sqrt(sv.uncertainty * sv.uncertainty + ev.uncertainty * ev.uncertainty)
  END AS z_score,
  ev.degassed AS exp_degassed, ev.magnet AS exp_magnet, ev.pulse_sequence AS exp_pulse_sequence,
  sv.simulation_id, ev.experiment_id, sv.result_id
FROM sim_v sv
JOIN exp_v ev ON ev.quantity = sv.quantity AND ev.p = sv.p AND ev.q IS sv.q
JOIN tol
JOIN quantities qu ON qu.quantity = sv.quantity
JOIN compounds cp ON cp.compound_id = sv.p
LEFT JOIN compounds cq ON cq.compound_id = sv.q
WHERE abs(sv.xp - ev.xp) <= tol.tx
  AND sv.t IS NOT NULL AND ev.t IS NOT NULL AND abs(sv.t - ev.t) <= tol.tt;

INSERT OR IGNORE INTO meta (key, value) VALUES
  ('schema_version', '3'),
  ('created_at', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ('match_tol_x', '0.01'),
  ('match_tol_t_k', '1.0');
