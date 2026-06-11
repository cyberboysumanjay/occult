// Package telegram pushes a card (text caption + rendered PNG) to a Telegram
// chat for each new reading, via the Bot API sendPhoto method.
package telegram

import (
	"bytes"
	"fmt"
	"html"
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

// Caption builds the HTML caption (Telegram limit is 1024 chars; this stays well
// under). Arrows convey direction; HTML <b> highlights the headline.
func Caption(d CardData) string {
	var b strings.Builder
	fmt.Fprintf(&b, "⚖️ <b>%.1f kg</b>", d.WeightKg)
	if d.ProfileName != "" {
		fmt.Fprintf(&b, " — %s", html.EscapeString(d.ProfileName))
	}
	b.WriteString("\n")
	b.WriteString(html.EscapeString(d.Ts.Local().Format("Mon 02 Jan 2006 · 15:04")))
	b.WriteString("\n")

	if line := metricsLine(d); line != "" {
		fmt.Fprintf(&b, "\n<i>%s</i>\n", html.EscapeString(line))
	}

	if len(d.Deltas) > 0 {
		b.WriteString("\n<b>Trend</b>\n<pre>")
		for _, dv := range d.Deltas {
			if !dv.Available {
				fmt.Fprintf(&b, "%-9s   —\n", dv.Label+":")
				continue
			}
			arrow, txt, _ := deltaParts(dv)
			fmt.Fprintf(&b, "%-9s %s%s kg\n", dv.Label+":", arrow, txt)
		}
		b.WriteString("</pre>")
	}
	return strings.TrimRight(b.String(), "\n")
}
