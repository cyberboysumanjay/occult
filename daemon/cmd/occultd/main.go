// Command occultd is a single-binary Bluetooth body-scale logger.
//
// It runs two things in one process:
//   - a BLE listener that captures each weigh-in from the Cult Smart Scale and
//     writes it (with a derived body-comp snapshot) to SQLite, and
//   - a web dashboard + JSON API over that same database, including first-run
//     onboarding and a settings panel.
//
// Configuration (profile, Telegram, scale tuning) lives in the database and is
// edited through the web UI. Only the two bootstrap values below are flags:
//
//	occultd -db /var/lib/occultd/occult.db -addr :8765
package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"occultd"
	"occultd/internal/ble"
	"occultd/internal/bodycomp"
	"occultd/internal/httpapi"
	"occultd/internal/protocol"
	"occultd/internal/settings"
	"occultd/internal/stats"
	"occultd/internal/store"
	"occultd/internal/telegram"
)

func main() {
	log.SetFlags(log.LstdFlags)
	dbPath := flag.String("db", "/var/lib/occultd/occult.db", "path to the SQLite database file")
	addr := flag.String("addr", ":8765", "dashboard + API listen address")
	flag.Parse()

	if dir := filepath.Dir(*dbPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("database dir: %v", err)
		}
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer st.Close()

	if cfg, err := st.GetSettings(); err == nil && !cfg.Onboarded {
		log.Printf("not yet configured — open http://<host>%s to onboard", *addr)
	}
	log.Printf("occultd starting — db %s", *dbPath)

	// ── HTTP dashboard + API (own goroutine) ────────────────────────────────
	webFS, err := fs.Sub(occultd.WebFS, "web")
	if err != nil {
		log.Fatalf("embed web assets: %v", err)
	}
	srv := httpapi.New(st, webFS)
	go func() {
		if err := srv.ListenAndServe(*addr); err != nil {
			log.Fatalf("http server: %v", err)
		}
	}()

	// ── BLE listener (blocks until signal) ──────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	listener := ble.New(scaleOptions(st), saveReading(st))
	if err := listener.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("ble listener: %v", err)
	}
	log.Printf("occultd shutting down")
}

// scaleOptions returns a provider that reads the current scale tuning from the
// database each scan cycle, so UI changes apply without a restart.
func scaleOptions(st *store.Store) func() ble.Options {
	return func() ble.Options {
		cfg, err := st.GetSettings()
		if err != nil {
			cfg = settings.Defaults()
			cfg.Normalize()
		}
		return ble.Options{
			NamePrefixes:  cfg.Scale.NamePrefixes,
			RSSIThreshold: cfg.Scale.RSSIThreshold,
			MinWeightKg:   cfg.Scale.MinWeightKg,
			MaxWeightKg:   cfg.Scale.MaxWeightKg,
			Cooldown:      time.Duration(cfg.Scale.CooldownSeconds) * time.Second,
		}
	}
}

// saveReading derives the body-comp snapshot from the current profile, persists
// one completed weigh-in, and (if configured) pushes a Telegram card.
func saveReading(st *store.Store) func(protocol.Complete) {
	return func(c protocol.Complete) {
		cfg, err := st.GetSettings()
		if err != nil {
			log.Printf("settings: %v — using defaults", err)
			cfg = settings.Defaults()
		}
		p := cfg.Profile

		age := 0
		if p.BirthYear > 0 {
			age = time.Now().Year() - p.BirthYear
		}
		d := bodycomp.Compose(bodycomp.Profile{Age: age, Sex: p.Sex, HeightCm: p.HeightCm}, c.WeightKg)

		r := store.Reading{
			Ts:           time.Now().UTC().Format(time.RFC3339),
			WeightKg:     c.WeightKg,
			HeartRate:    nonZeroInt(c.HeartRate),
			ImpedanceRaw: nonZeroInt(c.ImpedanceRaw),
			Source:       "scale",
			Reason:       c.Reason,
		}
		if p.HeightCm > 0 { // body-comp only meaningful with a height
			r.BMI = ptrF(d.BMI)
			r.BMIClass = d.BMIClass
			r.BodyFatPct = ptrF(d.BodyFatPct)
			r.FatMassKg = ptrF(d.FatMassKg)
			r.FFMKg = ptrF(d.FFMKg)
			r.TBWL = ptrF(d.TBWL)
			r.BodyWaterPct = ptrF(d.BodyWaterPct)
			r.BMRKcal = ptrI(d.BMRKcal)
			r.SMMKg = d.SMMKg
			r.SMMPct = d.SMMPct
		}

		id, err := st.Insert(r)
		if err != nil {
			log.Printf("save reading: %v", err)
			return
		}
		r.ID = id
		log.Printf("saved reading #%d (%.2f kg)", id, c.WeightKg)

		if cfg.Telegram.Enabled {
			notify(st, telegram.New(cfg.Telegram.BotToken, cfg.Telegram.ChatID), p.Name, r)
		}
	}
}

// notify builds the Telegram card (deltas + sparkline) and sends it without
// blocking the capture loop.
func notify(st *store.Store, notifier *telegram.Notifier, name string, r store.Reading) {
	history, err := st.List("")
	if err != nil {
		log.Printf("telegram: load history: %v", err)
		return
	}
	now := time.Now()
	deltas := stats.Deltas(history, r, now)

	ts, err := time.Parse(time.RFC3339, r.Ts)
	if err != nil {
		ts = now
	}

	cd := telegram.CardData{
		ProfileName:  name,
		Ts:           ts,
		WeightKg:     r.WeightKg,
		BMI:          r.BMI,
		BMIClass:     r.BMIClass,
		BodyFatPct:   r.BodyFatPct,
		BMRKcal:      r.BMRKcal,
		BodyWaterPct: r.BodyWaterPct,
		HeartRate:    r.HeartRate,
		Deltas:       toDeltaViews(deltas),
		Spark:        sparkline(history, 30),
	}

	go func() {
		if err := notifier.Send(cd); err != nil {
			log.Printf("telegram: send failed: %v", err)
		} else {
			log.Printf("telegram: card sent")
		}
	}()
}

func toDeltaViews(ds []stats.Delta) []telegram.DeltaView {
	out := make([]telegram.DeltaView, len(ds))
	for i, d := range ds {
		out[i] = telegram.DeltaView{Label: d.Label, Available: d.Available, DeltaKg: d.DeltaKg}
	}
	return out
}

// sparkline returns up to the last n weights (ascending) for the trend line.
func sparkline(history []store.Reading, n int) []float64 {
	start := 0
	if len(history) > n {
		start = len(history) - n
	}
	out := make([]float64, 0, len(history)-start)
	for _, r := range history[start:] {
		out = append(out, r.WeightKg)
	}
	return out
}

func nonZeroInt(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }
