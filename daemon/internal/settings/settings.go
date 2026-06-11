// Package settings is occultd's UI-editable configuration, persisted in SQLite
// (see store.GetSettings/SaveSettings) rather than a TOML file. Only the
// database path and HTTP listen address remain as process flags; everything
// here is set through the web onboarding wizard and settings panel.
package settings

// Settings is the full editable configuration document (stored as JSON).
type Settings struct {
	Onboarded bool     `json:"onboarded"` // derived on save; true once the profile is usable
	Profile   Profile  `json:"profile"`
	Telegram  Telegram `json:"telegram"`
	Scale     Scale    `json:"scale"`
}

// Profile is the single user (this scale can't distinguish people).
type Profile struct {
	Name      string  `json:"name"`
	Sex       string  `json:"sex"`       // "male" | "female"
	BirthYear int     `json:"birthYear"` // stored, not age
	HeightCm  float64 `json:"heightCm"`
}

// Telegram push credentials (blank = disabled).
type Telegram struct {
	BotToken string `json:"botToken"`
	ChatID   string `json:"chatId"`
	Enabled  bool   `json:"enabled"` // derived: both fields set
}

// Scale tunes BLE discovery and the sane-weight gate.
type Scale struct {
	NamePrefixes    []string `json:"namePrefixes"`
	RSSIThreshold   int      `json:"rssiThreshold"`
	MinWeightKg     float64  `json:"minWeightKg"`
	MaxWeightKg     float64  `json:"maxWeightKg"`
	CooldownSeconds int      `json:"cooldownSeconds"`
}

// Defaults returns a fresh, not-yet-onboarded configuration.
func Defaults() Settings {
	return Settings{
		Onboarded: false,
		Profile:   Profile{Sex: "male"},
		Scale: Scale{
			NamePrefixes:    []string{"Cult", "CULT"},
			RSSIThreshold:   -80,
			MinWeightKg:     5,
			MaxWeightKg:     300,
			CooldownSeconds: 20,
		},
	}
}

// Normalize fills defaults for any unset/invalid fields and recomputes derived
// flags (Telegram.Enabled, Onboarded). Call before persisting and after loading.
func (s *Settings) Normalize() {
	d := Defaults()
	if len(s.Scale.NamePrefixes) == 0 {
		s.Scale.NamePrefixes = d.Scale.NamePrefixes
	}
	if s.Scale.RSSIThreshold == 0 {
		s.Scale.RSSIThreshold = d.Scale.RSSIThreshold
	}
	if s.Scale.MinWeightKg <= 0 {
		s.Scale.MinWeightKg = d.Scale.MinWeightKg
	}
	if s.Scale.MaxWeightKg <= 0 {
		s.Scale.MaxWeightKg = d.Scale.MaxWeightKg
	}
	if s.Scale.MaxWeightKg <= s.Scale.MinWeightKg {
		s.Scale.MaxWeightKg = d.Scale.MaxWeightKg
	}
	if s.Scale.CooldownSeconds <= 0 {
		s.Scale.CooldownSeconds = d.Scale.CooldownSeconds
	}
	if s.Profile.Sex != "female" {
		s.Profile.Sex = "male"
	}
	s.Telegram.Enabled = s.Telegram.BotToken != "" && s.Telegram.ChatID != ""
	s.Onboarded = s.Profile.Name != "" && s.Profile.HeightCm > 0
}
