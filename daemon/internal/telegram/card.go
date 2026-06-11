// Card rendering for the Telegram notification — a single PNG that showcases the
// reading and its trend chips. Pure Go (fogleman/gg + the embedded Go font), so
// the binary stays CGO-free and needs no font files on disk.
package telegram

import (
	"bytes"
	"fmt"
	"image/color"
	"math"
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

	// ── Header: profile name + timestamp ───────────────────────────────────
	dc.SetFontFace(face(fontBold, 28))
	dc.SetHexColor(colText)
	name := d.ProfileName
	if name == "" {
		name = "occult"
	}
	dc.DrawString(name, padX, 86)

	dc.SetFontFace(face(fontRegular, 18))
	dc.SetHexColor(colMuted)
	dateStr := d.Ts.Local().Format("Mon 02 Jan 2006 · 15:04")
	dw, _ := dc.MeasureString(dateStr)
	dc.DrawString(dateStr, cardW-padX-dw, 84)

	// ── Hero weight ─────────────────────────────────────────────────────────
	dc.SetFontFace(face(fontBold, 118))
	dc.SetHexColor(colGold)
	weightStr := fmt.Sprintf("%.1f", d.WeightKg)
	dc.DrawString(weightStr, padX, 230)
	ww, _ := dc.MeasureString(weightStr)
	dc.SetFontFace(face(fontRegular, 40))
	dc.SetHexColor(colMuted)
	dc.DrawString("kg", padX+ww+18, 230)

	// ── Secondary metrics line ──────────────────────────────────────────────
	dc.SetFontFace(face(fontRegular, 22))
	dc.SetHexColor(colText)
	dc.DrawString(metricsLine(d), padX, 286)

	// ── Sparkline (recent weights) ──────────────────────────────────────────
	drawSparkline(dc, d.Spark, padX, 322, cardW-2*padX, 120)

	// ── Delta chips ─────────────────────────────────────────────────────────
	drawDeltas(dc, d.Deltas, padX, 470, cardW-2*padX, 110)

	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func metricsLine(d CardData) string {
	parts := []string{}
	if d.BMI != nil {
		s := fmt.Sprintf("BMI %.1f", *d.BMI)
		if d.BMIClass != "" {
			s += " (" + d.BMIClass + ")"
		}
		parts = append(parts, s)
	}
	if d.BodyFatPct != nil {
		parts = append(parts, fmt.Sprintf("Fat %.1f%%", *d.BodyFatPct))
	}
	if d.BMRKcal != nil {
		parts = append(parts, fmt.Sprintf("BMR %d kcal", *d.BMRKcal))
	}
	if d.BodyWaterPct != nil {
		parts = append(parts, fmt.Sprintf("Water %.1f%%", *d.BodyWaterPct))
	}
	if d.HeartRate != nil {
		parts = append(parts, fmt.Sprintf("HR %d bpm", *d.HeartRate))
	}
	return join(parts, "   ·   ")
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
	if len(deltas) == 0 {
		return
	}
	cw := w / float64(len(deltas))
	for i, dv := range deltas {
		cx := x + cw*float64(i) + cw/2

		// Label.
		dc.SetFontFace(face(fontRegular, 17))
		dc.SetHexColor(colMuted)
		dc.DrawStringAnchored(dv.Label, cx, y+14, 0.5, 0.5)

		// Value with arrow + colour.
		dc.SetFontFace(face(fontBold, 30))
		arrow, txt, col := deltaParts(dv)
		dc.SetHexColor(col)
		dc.DrawStringAnchored(arrow+txt, cx, y+58, 0.5, 0.5)
	}
}

// deltaParts returns the arrow glyph, value text and colour for a chip.
func deltaParts(dv DeltaView) (arrow, txt, col string) {
	if !dv.Available {
		return "", "—", colMuted
	}
	switch {
	case dv.DeltaKg > 0.0005:
		return "▲ ", fmt.Sprintf("+%.2f", dv.DeltaKg), colUp
	case dv.DeltaKg < -0.0005:
		return "▼ ", fmt.Sprintf("%.2f", dv.DeltaKg), colDown // already has '-'
	default:
		return "▬ ", "0.00", colMuted
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
