// Package store is the SQLite persistence layer for occultd.
//
// One table — readings — whose columns mirror occult's Reading shape (raw scale
// fields first, then the derived body-comp snapshot) so the data is portable to
// the occult PWA later if desired. Pure Go (modernc.org/sqlite): no cgo, builds
// static and cross-compiles cleanly.
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"occultd/internal/bodycomp"
	"occultd/internal/settings"

	_ "modernc.org/sqlite" // registers the "sqlite" database/sql driver
)

// Reading is one weigh-in. JSON tags are camelCase to match the occult PWA and
// the dashboard API contract. Pointer fields serialise to null when absent.
type Reading struct {
	ID           int64    `json:"id"`
	Ts           string   `json:"ts"` // RFC3339 UTC
	WeightKg     float64  `json:"weightKg"`
	HeartRate    *int     `json:"heartRate"`
	ImpedanceRaw *int     `json:"impedanceRaw"`
	Source       string   `json:"source"` // "scale" | "manual" | "seed"
	BMI          *float64 `json:"bmi"`
	BMIClass     string   `json:"bmiClass"`
	BodyFatPct   *float64 `json:"bodyFatPct"`
	FatMassKg    *float64 `json:"fatMassKg"`
	FFMKg        *float64 `json:"ffmKg"`
	TBWL         *float64 `json:"tbwL"`
	BodyWaterPct *float64 `json:"bodyWaterPct"`
	BMRKcal      *int     `json:"bmrKcal"`
	SMMKg        *float64 `json:"smmKg"`
	SMMPct       *float64 `json:"smmPct"`
	Reason       string   `json:"reason"` // why the weigh-in finalised
}

// Store wraps the database handle.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS readings (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	ts             TEXT    NOT NULL,
	weight_kg      REAL    NOT NULL,
	heart_rate     INTEGER,
	impedance_raw  INTEGER,
	source         TEXT    NOT NULL DEFAULT 'scale',
	bmi            REAL,
	bmi_class      TEXT,
	body_fat_pct   REAL,
	fat_mass_kg    REAL,
	ffm_kg         REAL,
	tbw_l          REAL,
	body_water_pct REAL,
	bmr_kcal       INTEGER,
	smm_kg         REAL,
	smm_pct        REAL,
	reason         TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS app_settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// settingsKey is the single row that holds the JSON settings document.
const settingsKey = "config"

// Open opens (creating if needed) the SQLite database at path and ensures the
// schema exists. A busy timeout is set so the writer (BLE) and reader (HTTP)
// never trip over each other.
func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Insert writes a reading and returns its new auto-assigned id.
func (s *Store) Insert(r Reading) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO readings (
			ts, weight_kg, heart_rate, impedance_raw, source,
			bmi, bmi_class, body_fat_pct, fat_mass_kg, ffm_kg,
			tbw_l, body_water_pct, bmr_kcal, smm_kg, smm_pct, reason
		) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?)`,
		r.Ts, r.WeightKg, r.HeartRate, r.ImpedanceRaw, r.Source,
		r.BMI, nullStr(r.BMIClass), r.BodyFatPct, r.FatMassKg, r.FFMKg,
		r.TBWL, r.BodyWaterPct, r.BMRKcal, r.SMMKg, r.SMMPct, nullStr(r.Reason),
	)
	if err != nil {
		return 0, fmt.Errorf("insert reading: %w", err)
	}
	return res.LastInsertId()
}

const selectCols = `
	id, ts, weight_kg, heart_rate, impedance_raw, source,
	bmi, bmi_class, body_fat_pct, fat_mass_kg, ffm_kg,
	tbw_l, body_water_pct, bmr_kcal, smm_kg, smm_pct, reason`

// List returns readings ordered oldest→newest. If since is non-empty, only
// readings with ts strictly greater than since are returned.
func (s *Store) List(since string) ([]Reading, error) {
	q := `SELECT ` + selectCols + ` FROM readings`
	var args []any
	if since != "" {
		q += ` WHERE ts > ?`
		args = append(args, since)
	}
	q += ` ORDER BY ts ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("list readings: %w", err)
	}
	defer rows.Close()

	var out []Reading
	for rows.Next() {
		r, err := scanReading(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Delete removes a reading by id. It returns (false, nil) if no row matched.
func (s *Store) Delete(id int64) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM readings WHERE id = ?`, id)
	if err != nil {
		return false, fmt.Errorf("delete reading %d: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Latest returns the most-recent reading, or (nil, nil) if the table is empty.
func (s *Store) Latest() (*Reading, error) {
	row := s.db.QueryRow(`SELECT ` + selectCols + ` FROM readings ORDER BY ts DESC LIMIT 1`)
	r, err := scanReading(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// scanner is the shared interface of *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanReading(sc scanner) (Reading, error) {
	var (
		r   Reading
		hr  sql.NullInt64
		imp sql.NullInt64
		bmi sql.NullFloat64
		cls sql.NullString
		bf  sql.NullFloat64
		fm  sql.NullFloat64
		ffm sql.NullFloat64
		tbw sql.NullFloat64
		bw  sql.NullFloat64
		bmr sql.NullInt64
		smk sql.NullFloat64
		smp sql.NullFloat64
		rsn sql.NullString
	)
	if err := sc.Scan(
		&r.ID, &r.Ts, &r.WeightKg, &hr, &imp, &r.Source,
		&bmi, &cls, &bf, &fm, &ffm,
		&tbw, &bw, &bmr, &smk, &smp, &rsn,
	); err != nil {
		return Reading{}, err
	}
	r.HeartRate = intPtr(hr)
	r.ImpedanceRaw = intPtr(imp)
	r.BMI = floatPtr(bmi)
	r.BMIClass = cls.String
	r.BodyFatPct = floatPtr(bf)
	r.FatMassKg = floatPtr(fm)
	r.FFMKg = floatPtr(ffm)
	r.TBWL = floatPtr(tbw)
	r.BodyWaterPct = floatPtr(bw)
	r.BMRKcal = intPtr(bmr)
	r.SMMKg = floatPtr(smk)
	r.SMMPct = floatPtr(smp)
	r.Reason = rsn.String
	return r, nil
}

// ── Settings ─────────────────────────────────────────────────────────────────

// GetSettings returns the stored settings, or normalized defaults if none have
// been saved yet (first run). The result is always Normalize()d.
func (s *Store) GetSettings() (settings.Settings, error) {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM app_settings WHERE key = ?`, settingsKey).Scan(&raw)
	if err == sql.ErrNoRows {
		d := settings.Defaults()
		d.Normalize()
		return d, nil
	}
	if err != nil {
		return settings.Settings{}, fmt.Errorf("read settings: %w", err)
	}
	var cfg settings.Settings
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return settings.Settings{}, fmt.Errorf("decode settings: %w", err)
	}
	cfg.Normalize()
	return cfg, nil
}

// RederiveAll recomputes the body-comp snapshot for every reading from the given
// profile. Called after the profile is saved/changed so existing readings (e.g.
// ones captured before onboarding) pick up BMI/body-fat/etc. With no usable
// height the derived columns are cleared to NULL.
func (s *Store) RederiveAll(p settings.Profile) error {
	readings, err := s.List("")
	if err != nil {
		return err
	}
	age := 0
	if p.BirthYear > 0 {
		age = time.Now().Year() - p.BirthYear
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		UPDATE readings SET
			bmi=?, bmi_class=?, body_fat_pct=?, fat_mass_kg=?, ffm_kg=?,
			tbw_l=?, body_water_pct=?, bmr_kcal=?, smm_kg=?, smm_pct=?
		WHERE id=?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, r := range readings {
		if p.HeightCm > 0 && r.WeightKg > 0 {
			d := bodycomp.Compose(bodycomp.Profile{Age: age, Sex: p.Sex, HeightCm: p.HeightCm}, r.WeightKg)
			if _, err := stmt.Exec(d.BMI, d.BMIClass, d.BodyFatPct, d.FatMassKg, d.FFMKg,
				d.TBWL, d.BodyWaterPct, d.BMRKcal, d.SMMKg, d.SMMPct, r.ID); err != nil {
				return err
			}
		} else {
			if _, err := stmt.Exec(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, r.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// SaveSettings normalizes and upserts the settings document.
func (s *Store) SaveSettings(cfg settings.Settings) error {
	cfg.Normalize()
	blob, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	_, err = s.db.Exec(`
		INSERT INTO app_settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		settingsKey, string(blob))
	if err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

func intPtr(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

func floatPtr(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	return &n.Float64
}

// nullStr turns "" into a NULL so empty text columns stay NULL, not "".
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
