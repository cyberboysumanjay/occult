// Package ble runs the 24/7 Bluetooth listener: it watches for the Cult scale's
// advertisement, connects when you step on, drives the weigh-in state machine on
// the 0xfff4 notify characteristic, and hands the finished reading to a callback.
//
// Lifecycle per weigh-in:
//
//	scan ──match──▶ connect ──▶ subscribe 0xfff4 ──▶ feed frames to Session
//	      ▲                                              │
//	      └────────── cooldown ◀── onComplete ◀──────────┘ (hr-stable | timeout | disconnect)
//
// The scale only advertises while active, so scanning is idle until someone
// steps on. Backed by BlueZ/D-Bus on Linux (pure Go, no cgo).
package ble

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"

	"occultd/internal/protocol"
)

// Scale GATT identifiers (see ../../research/cult_scale_protocol.md).
var (
	scaleService    = bluetooth.New16BitUUID(0xFFF0) // primary data service
	measurementChar = bluetooth.New16BitUUID(0xFFF4) // notify: 11-byte frames
)

// Timing for a single capture. PostLockTimeout is the hard guarantee: once the
// weight locks, we finalise within this window even if the body phase never
// converges and no disconnect event arrives.
const (
	PostLockTimeout = 30 * time.Second // after weight locks → force-complete
	OverallTimeout  = 90 * time.Second // never locked within this → give up
)

// Options configures how the listener recognises and bounds a reading.
type Options struct {
	NamePrefixes  []string      // advertised-name prefixes, e.g. ["Cult","CULT"]
	RSSIThreshold int           // ignore adverts weaker than this (dBm); -100 ≈ accept all
	MinWeightKg   float64       // discard final readings below this
	MaxWeightKg   float64       // discard final readings above this
	Cooldown      time.Duration // ignore the scale this long after a capture
}

// Listener owns the adapter and the capture loop.
type Listener struct {
	optsFn     func() Options // re-read each scan cycle so settings changes apply live
	opts       Options        // current cycle's options (set at the top of each loop)
	onComplete func(protocol.Complete)
	adapter    *bluetooth.Adapter

	// disconnectCh is re-pointed per capture; the global connect handler forwards
	// power-off events here so a capture can finalise immediately.
	mu           sync.Mutex
	disconnectCh chan struct{}
}

// New builds a Listener. optsFn is called once per scan cycle to fetch the
// current options (so UI settings changes take effect without a restart).
// onComplete is invoked (synchronously, from the capture loop) per accepted reading.
func New(optsFn func() Options, onComplete func(protocol.Complete)) *Listener {
	return &Listener{optsFn: optsFn, onComplete: onComplete, adapter: bluetooth.DefaultAdapter}
}

// Run enables the adapter and loops scan→capture→cooldown until ctx is cancelled.
func (l *Listener) Run(ctx context.Context) error {
	if err := l.adapter.Enable(); err != nil {
		return err
	}
	// One global connect handler; forwards disconnects to the active capture.
	l.adapter.SetConnectHandler(func(_ bluetooth.Device, connected bool) {
		if connected {
			return
		}
		l.mu.Lock()
		ch := l.disconnectCh
		l.mu.Unlock()
		if ch != nil {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	})

	log.Printf("listening for scale…")
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Refresh options for this cycle so web-UI settings changes apply live.
		l.opts = l.optsFn()

		addr, name, found := l.scanForScale(ctx)
		if !found {
			continue // ctx cancelled
		}
		log.Printf("scale detected (%s %q) — connecting…", addr.String(), name)

		c, err := l.capture(ctx, addr)
		switch {
		case err != nil:
			log.Printf("capture error: %v", err)
		case c == nil:
			log.Printf("no reading this session (scale left without a stable weight)")
		case c.WeightKg < l.opts.MinWeightKg || c.WeightKg > l.opts.MaxWeightKg:
			log.Printf("ignoring out-of-range weight %.2f kg (bounds %.0f–%.0f)",
				c.WeightKg, l.opts.MinWeightKg, l.opts.MaxWeightKg)
		default:
			log.Printf("✓ reading: %.2f kg (hr=%d imp=%d, %s)", c.WeightKg, c.HeartRate, c.ImpedanceRaw, c.Reason)
			l.onComplete(*c)
		}

		// Cooldown so a lingering advert / quick re-step doesn't double-record.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(l.opts.Cooldown):
		}
	}
}

type scanHit struct {
	addr bluetooth.Address
	name string
}

// scanForScale blocks until a matching advertisement appears or ctx is cancelled.
func (l *Listener) scanForScale(ctx context.Context) (bluetooth.Address, string, bool) {
	hitCh := make(chan scanHit, 1)
	go func() {
		err := l.adapter.Scan(func(a *bluetooth.Adapter, res bluetooth.ScanResult) {
			if !l.matches(res) {
				return
			}
			select {
			case hitCh <- scanHit{res.Address, res.LocalName()}:
			default:
			}
			_ = a.StopScan()
		})
		if err != nil {
			log.Printf("scan error: %v", err)
			// Unblock the waiter so Run can retry after a short pause.
			select {
			case hitCh <- scanHit{}:
			default:
			}
		}
	}()

	select {
	case <-ctx.Done():
		_ = l.adapter.StopScan()
		return bluetooth.Address{}, "", false
	case hit := <-hitCh:
		if hit.name == "" && hit.addr == (bluetooth.Address{}) {
			// scan errored; brief backoff, report "not found" so Run loops.
			time.Sleep(2 * time.Second)
			return bluetooth.Address{}, "", false
		}
		return hit.addr, hit.name, true
	}
}

// matches decides whether an advertisement is our scale.
func (l *Listener) matches(res bluetooth.ScanResult) bool {
	if int(res.RSSI) < l.opts.RSSIThreshold {
		return false
	}
	if res.HasServiceUUID(scaleService) {
		return true
	}
	name := res.LocalName()
	for _, p := range l.opts.NamePrefixes {
		if p != "" && strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// capture connects, subscribes, and runs one weigh-in to completion. It returns
// (*Complete, nil) on success, (nil, nil) if the scale left before a weight
// locked, or (nil, err) on a connection/GATT failure.
func (l *Listener) capture(ctx context.Context, addr bluetooth.Address) (*protocol.Complete, error) {
	device, err := l.adapter.Connect(addr, bluetooth.ConnectionParams{})
	if err != nil {
		return nil, err
	}
	defer device.Disconnect()

	services, err := device.DiscoverServices([]bluetooth.UUID{scaleService})
	if err != nil {
		return nil, err
	}
	if len(services) == 0 {
		return nil, errNoService
	}
	chars, err := services[0].DiscoverCharacteristics([]bluetooth.UUID{measurementChar})
	if err != nil {
		return nil, err
	}
	if len(chars) == 0 {
		return nil, errNoChar
	}

	// Per-capture disconnect channel.
	disconnectCh := make(chan struct{}, 1)
	l.mu.Lock()
	l.disconnectCh = disconnectCh
	l.mu.Unlock()
	defer func() { l.mu.Lock(); l.disconnectCh = nil; l.mu.Unlock() }()

	sess := protocol.NewSession()
	var sessMu sync.Mutex // Session is touched from the notify goroutine AND here
	lockCh := make(chan struct{}, 1)
	doneCh := make(chan protocol.Complete, 1)

	err = chars[0].EnableNotifications(func(buf []byte) {
		sessMu.Lock()
		up, done := sess.Handle(buf)
		sessMu.Unlock()
		if up != nil {
			switch up.Kind {
			case "locked":
				log.Printf("weight locked: %.2f kg — reading HR / body composition…", up.WeightKg)
				select {
				case lockCh <- struct{}{}:
				default:
				}
			case "measuring":
				log.Printf("measuring… hr=%d imp=%v tick=%d", up.HeartRate, up.HasImpedance, up.Ticks)
			}
		}
		if done != nil {
			select {
			case doneCh <- *done:
			default:
			}
		}
	})
	if err != nil {
		return nil, err
	}

	finalize := func(reason string) *protocol.Complete {
		sessMu.Lock()
		defer sessMu.Unlock()
		return sess.Finalize(reason)
	}

	overall := time.NewTimer(OverallTimeout)
	defer overall.Stop()
	var lockC <-chan time.Time // nil until the weight locks

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()

		case c := <-doneCh:
			return &c, nil

		case <-lockCh:
			t := time.NewTimer(PostLockTimeout)
			defer t.Stop()
			lockC = t.C

		case <-lockC:
			return finalize("timeout"), nil

		case <-overall.C:
			// Either finalise a locked-but-unconverged reading, or give up.
			return finalize("timeout"), nil

		case <-disconnectCh:
			// Scale powered off — the natural end of a weigh-in.
			if c := finalize("disconnect"); c != nil {
				return c, nil
			}
			return nil, nil
		}
	}
}
