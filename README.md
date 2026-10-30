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
| `compounds` | Physical constants | a pure compound: CAS, SMILES, name, other names, formula, molar mass, density, δD, δP, δH, source |
| `experiments` | Experimental | one NMR measurement: sample, temperature, degassed, magnet, pulse sequence, echo times, scans, T₂ ± error, D ± error, location, date, user, comments |
| `simulations` | Simulated | one MD run: sample, temperature, molecule counts, force field, software, length, timestep, location, date, user, comments |
| `processed_results` | Processed data | one number an analysis script computed for a simulation: quantity, species, contribution, method, value ± uncertainty, script, source file |
| `quantities` | Processed data → Quantities | a kind of result (T1, T2, R1, R2, D, tau_c, and any you add) and the one unit it is stored in |
| `raw_data` | Raw data | a path or URL to a raw file, linked to at most one experiment or simulation |
| `meta` | (internal) | schema version, timestamps, Sim vs Exp matching tolerances |

### Views (computed, read-only)

| View | What it adds |
|---|---|
| `v_compounds` | `label` (see below), molar volume V = M/ρ and total Hansen parameter δt = √(δD² + δP² + δH²) |
| `v_experiments`, `v_simulations` | compound labels and CAS numbers (`compound_a`, `cas_a`, …), `sample_type` (pure / mixture), x_B; simulations also summarise whole-sample total T₂ and D |
| `v_processed` | processed results with their simulation's sample and the quantity's unit |
| `v_raw_data` | raw-data paths with the linked record's sample |
| `v_all_records` | experiments and simulations in one list with a `kind` column (experimental / simulated) |
| `v_mixture_hsp` | blend Hansen parameters of every mixture in the data |
| `v_sim_vs_exp` | simulated and measured T₂ and D paired automatically, with ratio, % difference and z-score |

### How compounds are identified

A compound is identified by its **CAS number first, SMILES second and name
third**. It needs at least one of the three, the others are optional, and
each one is unique across the table:

| Identifier | Unique how | Notes |
|---|---|---|
| CAS number | exact; forms and imports store it without spaces or leading zeros, so `0064-17-5` is saved as `64-17-5` | checked against its check digit when typed in a form |
| SMILES | exact text (SMILES is case-sensitive) | enforced by a trigger, not a `UNIQUE` constraint, so upgrading an older file that already repeats a SMILES doesn't fail; new repeats are refused |
| Name | ignoring upper/lower case of A–Z (SQLite's `NOCASE`) | optional since version 2 |

A compound can also have **other names** (`other_names`, separated by
semicolons, since version 3). They aren't shown as its label, but imports and
compound lookups recognise them like the name, and no other name can be
another compound's name. Merging duplicates fills them in automatically.

Wherever the app or a view shows a compound it uses its **label**: the name
if there is one, otherwise the CAS number, otherwise the SMILES
(`coalesce(name, cas, smiles)` in SQL).

### Merging duplicate compounds

Two rows for the same chemical (`butan-2-one` and `Methyl Ethyl Ketone
(MEK)`, say) split its data: experiments point at one, Hansen parameters sit
on the other. **Physical constants → Find duplicates** lists likely pairs, and
**Merge with another compound…** in any compound's panel merges any two.

**What the finder looks for.** Compounds that share a SMILES, and names (or
other names) that match once upper/lower case, punctuation, a leading `n-` and
a bracketed abbreviation at the end are ignored, so `1-4-dioxane` pairs with
`1,4-Dioxane` and `Tetrahydrofuran (THF)` with `tetrahydrofuran`. It can't
recognise synonyms written with different words (`2-butanone` and
`methyl ethyl ketone`, `isopropanol` and `2-propanol`); merge those by hand.

**What a merge does**, as one step that Undo reverses:

1. Every experiment, simulation and processed result that uses the compound
   being merged in is moved to the one you keep.
2. The merged-in compound is deleted.
3. The kept compound's blank values are filled from it. Where both have a
   different value, the kept one's stays unless you pick the other; for
   Source and Comments both are kept by default.
4. The name that isn't kept, and both compounds' other names, become other
   names of the kept compound, so later imports that use them still land on
   it.

**When a merge is refused:** the two have different CAS numbers (different
compounds by definition; correct the wrong one first), or an experiment or
simulation is a mixture of exactly these two, which would become a mixture of
a compound with itself.

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
12. **One CAS number, one compound.** Two rows with different CAS numbers are
    different compounds even if their SMILES or names match, and a row's CAS
    outranks its SMILES and name whenever they disagree.
13. **Names and SMILES are compared as text.** The app doesn't know chemistry:
    `2-butanone` and `butan-2-one`, or `C1COCCO1` and `O1CCOCC1`, are different
    text, so they only end up as one compound if a CAS number links them.

---

## Importing

**Import** accepts `.csv`, `.tsv`, `.json`, `.xlsx`, a `.sqlite` file (replaces
the database) and the app's own JSON backup (restores it). Nothing is written
until you confirm, and the whole file goes in as one transaction. The preview
lists each problem with its spreadsheet row number. By default a file with any
problem row imports nothing; tick **Skip rows with problems and import the
rest** to import the good rows (each skipped row is undone completely).

* **Column names are matched automatically**, including the names in the
  original field list ("Mol fraction", "Echo times", "# Scans", "Locations to
  raw data"…). You can change any mapping. The *Templates* buttons download
  CSVs with the exact names.
* **Units in headers are converted**: `T2 (ms)`, `Temp [°C]`, `D (cm^2/s)`,
  `D (nm^2/ns)`, `D (Å^2/ps)`, `D (1e-9 m^2/s)`, `t2_ms`. You can override the
  unit for each column.
* **Compounds are recognised by CAS number, then SMILES, then name**, using
  whichever of those three columns you map. The highest-ranked one that finds
  a compound decides. This applies when importing compounds and wherever an
  experiment, simulation or result names a compound.
  * **A matching CAS number wins even if the names differ.** The database's
    name is kept, and the preview lists the differences under *Names kept*
    (for example `heptane → n-Heptane`).
  * **Rows without a CAS number or SMILES are matched by name** (as are rows
    whose CAS and SMILES find nothing), ignoring upper/lower case, and then by
    other names. For that the Name column has to be mapped. If it's set to
    *ignore*, rows with only a name have nothing to be recognised by and are
    listed as problems.
  * **An import never renames a compound or changes a stored CAS number.** It
    fills a blank name, a blank CAS number, and a blank or different SMILES as
    long as no other compound already has that SMILES. An *Other names* column
    adds to a compound's other names and never removes any.
  * **Several rows for one compound are combined.** The first row that
    matches a compound updates it; later rows only fill what the earlier rows
    left blank. Where they disagree, the earlier row's value stays and the
    preview lists the difference under *Conflicts*.
  * **Values that already match aren't rewritten.** The preview counts those
    compounds under *Up to date*, so re-importing a file you exported shows
    exactly what, if anything, would change.
  * **Contradictions stop the row.** If the CAS stored for the compound that a
    row's SMILES or name points to differs from the row's own CAS, the row is
    listed as a problem and isn't imported.
  * **Lower-ranked disagreements are warnings.** If a row's CAS matches one
    compound but its name or SMILES belongs to another, the row updates the
    CAS match and the preview lists it under *Check matches* as a possible
    duplicate.
  * CAS numbers are compared after trimming spaces and leading zeros, and the
    preview flags any whose check digit is wrong. SMILES are compared as exact
    text, so they match when both sides come from the same source, such as
    PubChem. If two compounds already share a SMILES (possible only in a file
    upgraded from version 1), a row found by that SMILES needs a CAS number or
    a matching name to say which one it means; otherwise it's a problem row.
  * Two settings control compound imports. **Already in the database:** leave
    unchanged, or update with the file's filled-in cells (blank cells never
    erase anything). **Not in the database:** add them, add them with the name
    left blank when there's a CAS number or SMILES, or skip them.
  * Experiment, simulation and result imports can create missing compounds
    automatically. A value that looks like a CAS number or SMILES is stored as
    one, anything else as a name.
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

## Schema versions and upgrades

The schema version is stored in the `meta` table and shown on the Export page.
When the site opens a file made with an older version, it upgrades the copy in
your browser. The file itself (including `master.sqlite`) changes the next time
someone saves to it, so it's fine if labmates open it in the meantime. If an
upgrade fails, nothing in the database is changed and the site says why.

**Version 1 → 2** (CAS, SMILES and name as identifiers). SQLite can't make a
column optional in place, so the `compounds` table is rebuilt: the rows are
copied with the same `compound_id`s, which keeps every experiment, simulation
and result linked to the same compound, and the links are checked before the
upgrade is kept. Blank CAS, SMILES and name cells become empty (NULL). Two
compounds that already share a SMILES are left as they are; they still work
and can be edited, and the importer points them out as possible duplicates.
JSON backups made with version 1 restore into the current version the same
way.

**Version 2 → 3** (other names). Adds the empty `other_names` column to
`compounds`; every row and id stays as it is. In an upgraded file the column
sits at the end of the table rather than after `name`, which only affects
`SELECT *` column order.

## Changing the schema

1. Edit `schema.sql`.
2. Run `python tools/build_schema_js.py` to regenerate `lib/schema.js`
   (the site embeds the schema so it also works when opened from disk).
3. `schema.sql` only creates what's missing, so it doesn't change tables in an
   existing file. Either raise `SCHEMA_VERSION` in `app.js` and add a step to
   `MIGRATIONS` there (every copy of the site then upgrades files as it opens
   them), or for a one-off change run the `ALTER TABLE` / `CREATE VIEW`
   statements in the SQL console and save.

---

## Files

```
index.html        page shell
styles.css        styles
app.js            the app: database layer, sections, forms, import, SQL console
schema.sql        tables, views, constraints (source of truth)
lib/schema.js     schema.sql embedded as JavaScript (generated)
lib/              sql.js 1.14.2 (SQLite 3.49.1), Papa Parse 5.7.0, read-excel-file 9.3.12
data/             leave empty (optional public copy, see data/README.md)
tools/            build_schema_js.py
```

Third-party licences are in `lib/THIRD_PARTY_LICENSES.txt` (all MIT; SQLite
is public domain). Spreadsheet reading uses read-excel-file rather than the
npm build of SheetJS, because that build (0.18.5) has known
high-severity vulnerabilities when reading crafted files (CVE-2023-30533,
CVE-2024-22363) and the patched versions are distributed only from SheetJS's
own CDN.
