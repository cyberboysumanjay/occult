// Card rendering for the Telegram notification — a single PNG that showcases the
// reading and its trend chips. Pure Go (fogleman/gg + the embedded Go font), so
// the binary stays CGO-free and needs no font files on disk.
package telegram

import (
	"bytes"
	"fmt"
	"image/color"
	"math"
	"strconv"
	"time"

	"github.com/fogleman/gg"
	"github.com/golang/freetype/truetype"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
)

// DeltaView is one trend chip (weight change vs a baseline).
type DeltaView struct {
	Label     string
	Available bool
	DeltaKg   float64 // negative = lost weight
}

// CardData is everything the card and caption need — primitives only, so this
// package stays decoupled from store/stats/config.
type CardData struct {
	ProfileName  string
	Ts           time.Time
	WeightKg     float64
	BMI          *float64
	BMIClass     string
	BodyFatPct   *float64
	BMRKcal      *int
	BodyWaterPct *float64
	HeartRate    *int
	Deltas       []DeltaView
	Spark        []float64 // recent weights, ascending; sparkline source
}

// palette (dark occult theme, matching the dashboard).
const (
	colBG    = "#0e1014"
	colPanel = "#15181e"
	colGold  = "#d8a24a"
	colText  = "#ece4d3"
	colMuted = "#8a8472"
	colDown  = "#6db580" // weight decreased
	colUp    = "#d9805c" // weight increased
)

const (
	cardW = 1000
	cardH = 620
)

var (
	fontRegular = mustParse(goregular.TTF)
	fontBold    = mustParse(gobold.TTF)
)

func mustParse(ttf []byte) *truetype.Font {
	f, err := truetype.Parse(ttf)
	if err != nil {
		panic("telegram: parse embedded font: " + err.Error())
	}
	return f
}

func face(f *truetype.Font, points float64) font.Face {
	return truetype.NewFace(f, &truetype.Options{Size: points, DPI: 72, Hinting: font.HintingFull})
}

// RenderCard draws the reading card and returns PNG bytes.
func RenderCard(d CardData) ([]byte, error) {
	dc := gg.NewContext(cardW, cardH)

	// Background + subtle framed panel.
	dc.SetHexColor(colBG)
	dc.Clear()
	dc.SetHexColor(colPanel)
	dc.DrawRoundedRectangle(24, 24, cardW-48, cardH-48, 18)
	dc.Fill()
	dc.SetHexColor(colGold)
	dc.SetLineWidth(1.2)
	dc.DrawRoundedRectangle(24, 24, cardW-48, cardH-48, 18)
	dc.Stroke() // Stroke() clears the path so later Fill()s don't fill the border rect

	const padX = 56

	// ── Header: profile name + a prominent, readable date ───────────────────
	name := d.ProfileName
	if name == "" {
		name = "occult"
	}
	dc.SetFontFace(face(fontBold, 28))
	dc.SetHexColor(colText)
	dc.DrawString(name, padX, 84)

	dc.SetFontFace(face(fontRegular, 24))
	dc.SetHexColor(colText)
	dc.DrawString(d.Ts.Local().Format("Mon 02 Jan · 15:04"), padX, 126)

	// ── Hero weight (the strong focal point — gold on dark) ─────────────────
	dc.SetFontFace(face(fontBold, 120))
	dc.SetHexColor(colGold)
	weightStr := fmt.Sprintf("%.1f", d.WeightKg)
	dc.DrawString(weightStr, padX, 252)
	ww, _ := dc.MeasureString(weightStr)
	dc.SetFontFace(face(fontRegular, 40))
	dc.SetHexColor(colMuted)
	dc.DrawString("kg", padX+ww+18, 252)

	// ── Secondary metrics line (no BMI class — number alone) ────────────────
	dc.SetFontFace(face(fontRegular, 22))
	dc.SetHexColor(colText)
	dc.DrawString(cardMetricsLine(d), padX, 306)

	// ── Sparkline (recent weights) ──────────────────────────────────────────
	drawSparkline(dc, d.Spark, padX, 340, cardW-2*padX, 114)

	// ── Trend ───────────────────────────────────────────────────────────────
	drawDeltas(dc, d.Deltas, padX, 478, cardW-2*padX, 110)

	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// cardMetricsLine is the single secondary line on the card. No BMI class label
// (the number alone is enough, and the class reads as a daily judgement); BMR
// gets thousands separators.
func cardMetricsLine(d CardData) string {
	parts := []string{}
	if d.BodyFatPct != nil {
		parts = append(parts, fmt.Sprintf("Fat %.1f%%", *d.BodyFatPct))
	}
	if d.BodyWaterPct != nil {
		parts = append(parts, fmt.Sprintf("Water %.1f%%", *d.BodyWaterPct))
	}
	if d.BMRKcal != nil {
		parts = append(parts, fmt.Sprintf("BMR %s kcal", commaInt(*d.BMRKcal)))
	}
	if d.BMI != nil {
		parts = append(parts, fmt.Sprintf("BMI %.1f", *d.BMI))
	}
	if d.HeartRate != nil {
		parts = append(parts, fmt.Sprintf("HR %d bpm", *d.HeartRate))
	}
	return join(parts, "   ·   ")
}

// commaInt formats an integer with thousands separators (1961 → "1,961").
func commaInt(n int) string {
	s := strconv.Itoa(n)
	neg := false
	if len(s) > 0 && s[0] == '-' {
		neg, s = true, s[1:]
	}
	var out []byte
	for i := 0; i < len(s); i++ {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	if neg {
		return "-" + string(out)
	}
	return string(out)
}

// anyAvailable reports whether at least one delta has a baseline.
func anyAvailable(ds []DeltaView) bool {
	for _, d := range ds {
		if d.Available {
			return true
		}
	}
	return false
}

func drawSparkline(dc *gg.Context, vals []float64, x, y, w, h float64) {
	if len(vals) < 2 {
		return
	}
	mn, mx := vals[0], vals[0]
	for _, v := range vals {
		mn = math.Min(mn, v)
		mx = math.Max(mx, v)
	}
	span := mx - mn
	if span < 1e-9 {
		span = 1 // flat line — keep it centred
	}
	px := func(i int) float64 { return x + w*float64(i)/float64(len(vals)-1) }
	py := func(v float64) float64 { return y + h - (v-mn)/span*h }

	// Soft baseline.
	dc.SetHexColor(colMuted)
	dc.SetLineWidth(0.6)
	dc.DrawLine(x, y+h, x+w, y+h)
	dc.Stroke()

	// Filled area under the line.
	dc.MoveTo(px(0), py(vals[0]))
	for i, v := range vals {
		dc.LineTo(px(i), py(v))
	}
	dc.LineTo(px(len(vals)-1), y+h)
	dc.LineTo(px(0), y+h)
	dc.ClosePath()
	dc.SetColor(color.RGBA{0xd8, 0xa2, 0x4a, 0x22})
	dc.Fill()

	// The line itself.
	dc.SetHexColor(colGold)
	dc.SetLineWidth(2.4)
	dc.MoveTo(px(0), py(vals[0]))
	for i, v := range vals {
		dc.LineTo(px(i), py(v))
	}
	dc.Stroke()

	// End dot.
	last := len(vals) - 1
	dc.DrawCircle(px(last), py(vals[last]), 4)
	dc.Fill()
}

func drawDeltas(dc *gg.Context, deltas []DeltaView, x, y, w, h float64) {
	// All-empty (e.g. the very first reading) → one tidy line, not a row of
	// dashes that reads like a rendering bug.
	if !anyAvailable(deltas) {
		dc.SetFontFace(face(fontRegular, 24))
		dc.SetHexColor(colMuted)
		dc.DrawStringAnchored("No trend data yet", x+w/2, y+h/2, 0.5, 0.5)
		return
	}
	cw := w / float64(len(deltas))
	for i, dv := range deltas {
		cx := x + cw*float64(i) + cw/2

		dc.SetFontFace(face(fontRegular, 17))
		dc.SetHexColor(colMuted)
		dc.DrawStringAnchored(dv.Label, cx, y+14, 0.5, 0.5)

		if !dv.Available {
			dc.SetFontFace(face(fontRegular, 16))
			dc.SetHexColor(colMuted)
			dc.DrawStringAnchored("no data", cx, y+56, 0.5, 0.5)
			continue
		}
		// Sign + colour convey direction (the embedded font has no arrow glyphs).
		txt, col := cardDelta(dv.DeltaKg)
		dc.SetFontFace(face(fontBold, 28))
		dc.SetHexColor(col)
		dc.DrawStringAnchored(txt, cx, y+56, 0.5, 0.5)
	}
}

// cardDelta returns the value text and colour for a chip (green=down, red=up).
func cardDelta(d float64) (txt, col string) {
	switch {
	case d > 0.005:
		return fmt.Sprintf("+%.2f", d), colUp
	case d < -0.005:
		return fmt.Sprintf("%.2f", d), colDown // negative sign included
	default:
		return "0.00", colMuted
	}
}

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}
