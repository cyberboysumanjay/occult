package ble

import "errors"

var (
	// errNoService: the scale connected but didn't expose the 0xfff0 service.
	errNoService = errors.New("scale service 0xfff0 not found on device")
	// errNoChar: the 0xfff0 service had no 0xfff4 measurement characteristic.
	errNoChar = errors.New("measurement characteristic 0xfff4 not found")
)
