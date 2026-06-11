// Package telegram pushes a card (text caption + rendered PNG) to a Telegram
// chat for each new reading, via the Bot API sendPhoto method.
package telegram

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Notifier sends to one chat with one bot token.
type Notifier struct {
	token  string
	chatID string
	client *http.Client
}

// New builds a Notifier. token/chatID come from config; callers should only
// construct one when both are set (see settings.Telegram.Enabled).
func New(token, chatID string) *Notifier {
	return &Notifier{
		token:  token,
		chatID: chatID,
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

// Send renders the card and posts it with a caption. Safe to call from a
// goroutine; it performs network I/O and returns any error for logging.
func (n *Notifier) Send(d CardData) error {
	png, err := RenderCard(d)
	if err != nil {
		return fmt.Errorf("render card: %w", err)
	}
	return n.sendPhoto(png, Caption(d))
}

// SendText posts a plain HTML message (no image) via sendMessage.
func (n *Notifier) SendText(text string) error {
	form := url.Values{}
	form.Set("chat_id", n.chatID)
	form.Set("text", text)
	form.Set("parse_mode", "HTML")

	endpoint := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", n.token)
	resp, err := n.client.PostForm(endpoint, form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("telegram sendMessage %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// SendTest verifies a token/chat pair by sending a confirmation message. Used by
// the settings panel's "Send test message" button.
func SendTest(token, chatID string) error {
	if token == "" || chatID == "" {
		return fmt.Errorf("bot token and chat id are both required")
	}
	return New(token, chatID).SendText("✅ <b>occult</b> is connected. You'll get a card here after each weigh-in.")
}

func (n *Notifier) sendPhoto(png []byte, caption string) error {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("chat_id", n.chatID)
	_ = mw.WriteField("caption", caption)
	_ = mw.WriteField("parse_mode", "HTML")

	part, err := mw.CreateFormFile("photo", "occult.png")
	if err != nil {
		return err
	}
	if _, err := part.Write(png); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendPhoto", n.token)
	req, err := http.NewRequest(http.MethodPost, url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("telegram sendPhoto %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// Caption builds the Telegram message caption (HTML parse_mode; 1024-char limit).
// Emojis render natively in Telegram — unlike the card image, whose font has no
// emoji glyphs. Layout:
//
//	⚖️ 101.1 kg · Fri 12 Jun, 03:59
//
//	🫀 HR 91 bpm   🔥 BMR 1,961 kcal
//	💧 Water 52.0%   🫀 Fat 30.8%   BMI 34.2
//
//	📈 Trend
//	  vs last   → 0.00 kg
//	  1 day     no prior data
func Caption(d CardData) string {
	var b strings.Builder

	fmt.Fprintf(&b, "⚖️ <b>%.1f kg</b> · %s\n",
		d.WeightKg, d.Ts.Local().Format("Mon 02 Jan, 15:04"))

	// Metrics over up to two lines — only what's present.
	var l1, l2 []string
	if d.HeartRate != nil {
		l1 = append(l1, fmt.Sprintf("🫀 HR %d bpm", *d.HeartRate))
	}
	if d.BMRKcal != nil {
		l1 = append(l1, fmt.Sprintf("🔥 BMR %s kcal", commaInt(*d.BMRKcal)))
	}
	if d.BodyWaterPct != nil {
		l2 = append(l2, fmt.Sprintf("💧 Water %.1f%%", *d.BodyWaterPct))
	}
	if d.BodyFatPct != nil {
		l2 = append(l2, fmt.Sprintf("🫀 Fat %.1f%%", *d.BodyFatPct))
	}
	if d.BMI != nil {
		l2 = append(l2, fmt.Sprintf("BMI %.1f", *d.BMI))
	}
	if len(l1) > 0 || len(l2) > 0 {
		b.WriteString("\n")
		if len(l1) > 0 {
			b.WriteString(join(l1, "   ") + "\n")
		}
		if len(l2) > 0 {
			b.WriteString(join(l2, "   ") + "\n")
		}
	}

	b.WriteString("\n📈 <b>Trend</b>\n")
	if anyAvailable(d.Deltas) {
		b.WriteString("<pre>")
		for _, dv := range d.Deltas {
			if !dv.Available {
				fmt.Fprintf(&b, "  %-8s no prior data\n", dv.Label)
				continue
			}
			fmt.Fprintf(&b, "  %-8s %s\n", dv.Label, captionDelta(dv.DeltaKg))
		}
		b.WriteString("</pre>")
	} else {
		b.WriteString("No trend data yet")
	}
	return strings.TrimRight(b.String(), "\n")
}

// captionDelta formats a weight delta for the caption: arrow + magnitude.
func captionDelta(d float64) string {
	switch {
	case d > 0.005:
		return fmt.Sprintf("▲ %.2f kg", d)
	case d < -0.005:
		return fmt.Sprintf("▼ %.2f kg", -d)
	default:
		return "→ 0.00 kg"
	}
}
