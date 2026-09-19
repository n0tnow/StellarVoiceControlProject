# Polaris — developer entry points.
#
# Everything long-running goes through `caffeinate -i` (AGENTS.md §4); the heavy
# lifting lives in scripts/ so the same commands work from any shell.
SHELL := /bin/bash
.DEFAULT_GOAL := help

APP_MANIFEST := app/src-tauri/Cargo.toml
CHAIN_MANIFEST := contracts/Cargo.toml

.PHONY: help setup icons check check-chain check-contracts dev agent build build-contracts contracts-test clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install JS dependencies + generate icons
	bash scripts/setup.sh

icons: ## Regenerate the app icons (PNG set + .icns)
	python3 scripts/generate-icons.py

check: ## Typecheck JS workspaces, build the shell, cargo check the Tauri app
	bash scripts/check.sh

check-chain: ## Full check including the Soroban crate build+tests
	bash scripts/check.sh --chain

check-contracts: ## Soroban crate only: cargo test
	caffeinate -i cargo test --manifest-path $(CHAIN_MANIFEST)

dev: ## Run the desktop shell (Tauri dev, Vite HMR)
	bash scripts/dev.sh

agent: ## Run the agent skeleton smoke test
	npm run start -w @polaris/agent

build: ## Bundle the macOS app (release)
	cd app && caffeinate -i cargo tauri build

build-contracts: ## Build polaris_guard to wasm (requires stellar-cli >= 25.2.0)
	caffeinate -i stellar contract build --manifest-path $(CHAIN_MANIFEST)

contracts-test: ## Alias for check-contracts
	$(MAKE) check-contracts

clean: ## Remove build output (Rust targets, vite dist, node_modules)
	rm -rf app/dist app/src-tauri/target contracts/target node_modules
