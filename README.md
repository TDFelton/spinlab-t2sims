# NMR Relaxation Database

A small web app for experimental and simulated NMR relaxation data: T₂ and
self-diffusion coefficients for pure liquids and binary mixtures, the
physical constants behind them (including Hansen solubility parameters), what
the MD analysis scripts computed, and where the raw files live.

The database is a single **SQLite** file. The site runs entirely in the
browser (SQLite compiled to WebAssembly via [sql.js](https://github.com/sql-js/sql.js)),
so it can be hosted for free on GitHub Pages with no server, and the same file
opens in Python, R or DB Browser for SQLite.

---

## Put it on GitHub Pages

1. Create a repository (for example `nmr-relaxation-db`) and upload everything
   in this folder, keeping the folder structure (`lib/`, `data/`, `tools/`).
2. In the repository: **Settings → Pages → Build and deployment → Source:
   Deploy from a branch**, choose `main` and `/ (root)`, then **Save**.
3. After a minute or two the site is at
   `https://<your-username>.github.io/<repository-name>/`.

**Privacy.** GitHub Pages sites are public on the internet, even when the
repository is private, unless the repository belongs to an organization on
GitHub Enterprise Cloud. The site itself holds no data, so that's fine. Keep
the database in the lab's shared folder (below), not in the repository.

### Run it without GitHub

* **Double-click `index.html`.** Works offline. Browsers block WebAssembly
  files opened from disk, so it uses the slower asm.js build of SQLite, which
  is fine for a lab-sized database. The repository copy (`data/`) isn't read in
  this mode.
* **Or serve the folder:** `python -m http.server 8000` in this folder, then
  open <http://localhost:8000>.

---

## Where the data lives

| Place | What it is | Who sees it |
|---|---|---|
| **`master.sqlite` in the lab's shared folder** | The shared master copy | Whoever the folder is shared with |
| **This browser** (IndexedDB) | Your working copy, saved after every change | Only you, in this browser |
| **A `.sqlite` you download** | A snapshot of the whole database | Whoever you give it to |

### Set up the master file (once)

1. Pick a folder the lab already shares through OneDrive, Google Drive or
   Box, and make sure it syncs to your computer (the desktop sync app).
2. Open the site in **Chrome or Edge**, go to **Export**, and click
   **Create master file…**. Save it into that folder as `master.sqlite`. This
   starts the master from whatever is in your browser.
3. Everyone else: **Export → Open master file…** and pick `master.sqlite` in
   their synced copy of the folder.

### Day to day

* Open the site. If the browser asks, click **Open latest** (or choose
  "Allow on every visit" in Chrome's prompt so it loads automatically).
* Edit as usual, then click **Save to master** (or press Ctrl+S). The status
  line at the top says when you have changes that aren't saved to it.
* The sync app uploads the file; labmates get your changes the next time they
  open the site or switch back to its tab.

### When two people edit at once

The site remembers a fingerprint (SHA-256) of the master each time it loads or
saves it. If someone else saved in between, **Save to master** stops and
offers to download your version and load theirs, or to overwrite theirs. It
never overwrites silently. Nothing merges automatically: to combine both sets
of changes, re-enter yours, or export them as CSV from your downloaded copy and
import that into the master (the importer skips rows that already exist).
If a bad save ever slips through, roll back from the drive's version history:
OneDrive and Google Drive keep earlier versions for about 30 days, and Box
keeps a number of versions that depends on the plan.

### Other browsers

Saving straight to a file uses the File System Access API, which Chrome and
Edge support but Firefox and Safari don't (Brave only behind a flag). In those
browsers: **Export → Open a .sqlite file…** to load `master.sqlite`, edit,
then **Download .sqlite** and replace `master.sqlite` in the shared folder
with it, keeping the name.

**Also good to know**

* The browser shows the file's name but never its folder, and it only gets
  access to the one file you pick.
* Clearing browser data removes the working copy and the remembered link; the
  master file isn't affected. Link it again with **Open master file…**.
* Undo keeps the last 30 changes while the tab is open.
* The old route still works if you ever want a public copy: a
  `data/database.sqlite` committed to the repository is offered to visitors
  who aren't linked to a master.

---

## Data model

All tables are defined in [`schema.sql`](schema.sql). Values are stored in one
unit per column; forms and imports convert from other units on the way in.

| Quantity | Stored unit |
|---|---|
| T₁, T₂, correlation times, echo times | s |
| Relaxation rates R₁, R₂ | 1/s |
| Diffusion coefficients | m²/s |
| Temperature | K |
| Hansen δD, δP, δH | MPa½ |
| Molar mass / density | g/mol / g/cm³ |
| Simulation length / timestep | ns / fs |

### Tables (what you edit)

| Table | Section in the app | One row is… |
|---|---|---|
| `compounds` | Physical constants | a pure compound: name, CAS, formula, SMILES, molar mass, density, δD, δP, δH, source |
| `experiments` | Experimental | one NMR measurement: sample, temperature, degassed, magnet, pulse sequence, echo times, scans, T₂ ± error, D ± error, location, date, user, comments |
| `simulations` | Simulated | one MD run: sample, temperature, molecule counts, force field, software, length, timestep, location, date, user, comments |
| `processed_results` | Processed data | one number an analysis script computed for a simulation: quantity, species, contribution, method, value ± uncertainty, script, source file |
| `quantities` | Processed data → Quantities | a kind of result (T1, T2, R1, R2, D, tau_c, and any you add) and the one unit it is stored in |
| `raw_data` | Raw data | a path or URL to a raw file, linked to at most one experiment or simulation |
| `meta` | (internal) | schema version, timestamps, Sim vs Exp matching tolerances |

### Views (computed, read-only)

| View | What it adds |
|---|---|
| `v_compounds` | molar volume V = M/ρ and total Hansen parameter δt = √(δD² + δP² + δH²) |
| `v_experiments`, `v_simulations` | compound names, `sample_type` (pure / mixture), x_B; simulations also summarise whole-sample total T₂ and D |
| `v_processed` | processed results with their simulation's sample and the quantity's unit |
| `v_raw_data` | raw-data paths with the linked record's sample |
| `v_all_records` | experiments and simulations in one list with a `kind` column (experimental / simulated) |
| `v_mixture_hsp` | blend Hansen parameters of every mixture in the data |
| `v_sim_vs_exp` | simulated and measured T₂ and D paired automatically, with ratio, % difference and z-score |

### How "processed data" is organised

Each computed number is its own row ("long" or tidy format). A row says
*which simulation*, *which quantity* (T2, D…), *which species* (compound A,
compound B, or the whole sample), *which contribution* (total, intra, inter…)
and *which method* (e.g. ensemble single-exponential fit vs harmonic mean of
rates). New kinds of results need no new columns, and one simulation can carry
several methods side by side. The SQL console has an example that pivots
intra / inter / total back into columns.

### Assumptions built into the design

These are choices I made that you may want to change. Each one is a small edit
to `schema.sql` (see *Changing the schema* below).

1. **Mixtures are binary.** A record has compound A, optional compound B and
   x_A, the mole fraction of A. x_B = 1 − x_A is computed. A pure liquid has no
   compound B and x_A = 1.
2. **Sweep endpoints count as pure.** A record that names both compounds but
   has x_A = 0 or 1 appears under *Pure*, labelled as the endpoint of its pair.
3. **"Exp vs sim" is which table a record is in**, rather than a column you
   fill in. `v_all_records` exposes it as a `kind` column.
4. **Experiments hold their measured T₂ and D directly** (one value of each per
   measurement, plus optional uncertainties). Simulated values live in
   Processed data, because the scripts produce many numbers per run.
5. **"Location" is where the work was done** (lab or instrument; cluster or
   directory), and **"Locations to raw data" are file paths** in the Raw data
   table. A record can have any number of raw-data paths. Only paths are
   stored, never the files.
6. **Hansen parameters belong to pure compounds.** Blend values use the
   standard volume-fraction-weighted average with ideal mixing (no excess
   volume): φ_A = x_A V_A / (x_A V_A + x_B V_B), δ_mix = φ_A δ_A + φ_B δ_B,
   with V = M/ρ. Tabulated Hansen parameters are usually given at 25 °C.
7. **Sim vs Exp pairing** treats compound order as irrelevant
   (benzene/toluene x = 0.3 matches toluene/benzene x = 0.7), and accepts
   |Δx| ≤ 0.01 and |ΔT| ≤ 1 K by default (change both on the *Export* page).
   It compares only whole-sample, `total` values, so species-level D from a
   simulation isn't paired with the single D stored per experiment.
8. **z-score** = (sim − exp) / √(u_sim² + u_exp²), shown only when both
   uncertainties are given, and it assumes they are independent.
9. **Degassed** is yes / no / unknown. Sim vs Exp colours points by it because
   dissolved O₂ is paramagnetic and shortens T₂, so non-degassed samples
   usually relax faster than a simulation without O₂.
10. **Dates** are stored as `YYYY-MM-DD`. Imported dates written with slashes
    are read as month/day/year.
11. **Unit conversions** round to 12 significant figures to remove
    floating-point noise (e.g. 25 °C → 298.15 K exactly).

---

## Importing

**Import** accepts `.csv`, `.tsv`, `.json`, `.xlsx`, a `.sqlite` file (replaces
the database) and the app's own JSON backup (restores it). Nothing is written
until you confirm, the whole file goes in as one transaction, and a file with
any invalid row imports nothing until it's fixed (the preview lists each
problem with its spreadsheet row number).

* **Column names are matched automatically**, including the names in the
  original field list ("Mol fraction", "Echo times", "# Scans", "Locations to
  raw data"…). You can change any mapping. The *Templates* buttons download
  CSVs with the exact names.
* **Units in headers are converted**: `T2 (ms)`, `Temp [°C]`, `D (cm^2/s)`,
  `D (nm^2/ns)`, `D (Å^2/ps)`, `D (1e-9 m^2/s)`, `t2_ms`. You can override the
  unit for each column.
* **Compounds are recognised by CAS number, then SMILES, then name**, using
  whichever of those columns you map. This applies when importing compounds
  and wherever an experiment, simulation or result names a compound. Names
  already in the database are never changed by an import, so a file can call
  1,4-dioxane `1-4-dioxane` and still update the right row.
  * CAS numbers are matched after trimming spaces and leading zeros, and the
    preview flags any whose check digit is wrong.
  * SMILES are matched as exact text, because the same molecule can be written
    several ways (`C1COCCO1` and `O1CCOCC1` are both 1,4-dioxane). Matching
    works when both sides come from the same source, such as PubChem.
  * If a row's CAS disagrees with the CAS stored for the compound its SMILES
    or name points to, the row is flagged instead of imported.
  * Compound imports have two settings: what to do with compounds already in
    the database (leave them, or fill in values from the file's non-blank
    cells) and with compounds that aren't (add them using the file's name or
    their CAS number, or skip them). Every new compound needs a name, so a
    row without one is named by its CAS number, or by its SMILES if it has no
    CAS; rename it later in Physical constants.
  * Experiment, simulation and result imports can create missing compounds
    automatically.
* **Results from your scripts** can be long (columns `quantity`, `value`,
  `contribution`, `species`, `method`, optional `unit`) or wide (one row per
  simulation with columns like `T2_intra`, `T2_inter`, `T2_total`,
  `T2_total_err`, `D_A`, `D_B`). Each row finds its simulation by
  `simulation_id`, or by compounds + x_A + temperature; missing simulations
  can be created.
* **JSON** can be a list of objects, an object holding such a list, or an
  object keyed by name (`{"benzene": {...}, "toluene": {...}}`, the key becomes
  the name). Nested objects are flattened (`hsp.d` → `hsp_d`).
* Rows identical to existing records are skipped, so re-importing a file is
  safe. *Only rows where…* filters a sheet that mixes kinds of rows (for
  example an "Exp vs sim" column).
* `.xls` and `.ods` aren't read: save as `.xlsx` or `.csv`.

---

## Querying from Python

```python
import sqlite3
import pandas as pd

con = sqlite3.connect("database.sqlite")
con.execute("PRAGMA foreign_keys = ON")   # SQLite enforces links only when this is on

pairs = pd.read_sql("""
    SELECT compound_1, compound_2, x_1, temperature_exp_k,
           sim_method, sim_value, exp_value, pct_diff
    FROM v_sim_vs_exp
    WHERE quantity = 'T2' AND exp_degassed = 1
""", con)
```

Scripts can also write results straight into the file (insert into
`processed_results` with the right `simulation_id`); the site picks them up when
that file is opened or committed.

---

## Changing the schema

1. Edit `schema.sql`.
2. Run `python tools/build_schema_js.py` to regenerate `lib/schema.js`
   (the site embeds the schema so it also works when opened from disk).
3. Existing databases are not migrated automatically: the schema only creates
   what's missing in a new, empty database. For an existing file, run the
   matching `ALTER TABLE` / `CREATE VIEW` statements in the SQL console, then
   download and commit it.

---

## Files

```
index.html        page shell
styles.css        styles (light and dark)
app.js            the app: database layer, sections, forms, import, SQL console
schema.sql        tables, views, constraints (source of truth)
lib/schema.js     schema.sql embedded as JavaScript (generated)
lib/              sql.js 1.14.2 (SQLite 3.49.1), Papa Parse 5.7.0, read-excel-file 9.3.12
data/             put database.sqlite here to share it through the site
tools/            build_schema_js.py
```

Third-party licences are in `lib/THIRD_PARTY_LICENSES.txt` (all MIT; SQLite
is public domain). Spreadsheet reading uses read-excel-file rather than the
npm build of SheetJS, because that build (0.18.5) has known
high-severity vulnerabilities when reading crafted files (CVE-2023-30533,
CVE-2024-22363) and the patched versions are distributed only from SheetJS's
own CDN.
