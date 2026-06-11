package settings

import "testing"

func TestNormalize_DerivesFlags(t *testing.T) {
	s := Defaults()
	s.Profile.Name = "Ansuman"
	s.Profile.HeightCm = 178
	s.Telegram.BotToken = "tok"
	s.Telegram.ChatID = "123"
	s.Normalize()

	if !s.Onboarded {
		t.Error("name + height should mark onboarded")
	}
	if !s.Telegram.Enabled {
		t.Error("both telegram fields set should mark enabled")
	}
}

func TestNormalize_NotOnboardedWithoutHeight(t *testing.T) {
	s := Defaults()
	s.Profile.Name = "Ansuman" // no height
	s.Normalize()
	if s.Onboarded {
		t.Error("missing height should not be onboarded")
	}
}

func TestNormalize_FillsDefaults(t *testing.T) {
	var s Settings // entirely zero
	s.Normalize()
	if len(s.Scale.NamePrefixes) == 0 {
		t.Error("name prefixes should default")
	}
	if s.Scale.MinWeightKg >= s.Scale.MaxWeightKg {
		t.Errorf("weight bounds invalid after defaults: %v..%v", s.Scale.MinWeightKg, s.Scale.MaxWeightKg)
	}
	if s.Scale.CooldownSeconds <= 0 {
		t.Error("cooldown should default to a positive value")
	}
	if s.Profile.Sex != "male" {
		t.Errorf("sex should default to male, got %q", s.Profile.Sex)
	}
	if s.Telegram.Enabled || s.Onboarded {
		t.Error("empty settings should be neither enabled nor onboarded")
	}
}
