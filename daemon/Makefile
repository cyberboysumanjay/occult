BINARY      := occultd
CMD         := ./cmd/occultd
BIN_DIR     := bin

# Default build — native OS/arch, no CGO.
.PHONY: build
build:
	CGO_ENABLED=0 go build -o $(BIN_DIR)/$(BINARY) $(CMD)

# Cross-compile targets (all CGO-free, safe to run from any host OS).
.PHONY: linux-amd64
linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o $(BIN_DIR)/$(BINARY)-linux-amd64 $(CMD)

.PHONY: linux-arm64
linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $(BIN_DIR)/$(BINARY)-linux-arm64 $(CMD)

# Raspberry Pi 2/3 in 32-bit mode (armv6/armv7 userland).
.PHONY: linux-arm
linux-arm:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -o $(BIN_DIR)/$(BINARY)-linux-arm $(CMD)

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: test
test:
	go test ./...

.PHONY: run
run:
	go run $(CMD) -db ./occult.db -addr :8765

# Copies the locally built binary to /usr/local/bin (requires sudo).
.PHONY: install
install: build
	sudo cp $(BIN_DIR)/$(BINARY) /usr/local/bin/$(BINARY)

.PHONY: clean
clean:
	rm -rf $(BIN_DIR)
