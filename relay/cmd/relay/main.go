// Command relay runs the scrutiny-fabric pilot relay.
//
// Usage:
//
//	relay            run the relay (configuration from the SCRUTINY_* environment)
//	relay reindex    wipe the bleve search index and replay the base store into it
//
// The environment is documented in the repository README.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/relay"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/store"
)

func main() {
	logger := log.New(os.Stderr, "[scrutiny-relay] ", log.LstdFlags)

	if args := os.Args[1:]; len(args) > 0 {
		switch args[0] {
		case "reindex":
			if err := runReindex(logger); err != nil {
				logger.Printf("reindex failed: %v", err)
				os.Exit(1)
			}
			return
		case "help", "-h", "--help":
			fmt.Fprintf(os.Stderr, "usage: %s [reindex]\n", os.Args[0])
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown subcommand %q\nusage: %s [reindex]\n", args[0], os.Args[0])
			os.Exit(2)
		}
	}

	if err := runRelay(logger); err != nil {
		logger.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func runRelay(logger *log.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	bundle, err := relay.Build(cfg, logger)
	if err != nil {
		return fmt.Errorf("initializing the relay: %w", err)
	}
	defer bundle.Close()

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           bundle.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()

	logger.Printf("relay %s listening on %s (service url %q, data dir %s)",
		relay.Version, cfg.ListenAddr, cfg.ServiceURL, cfg.DataDir)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-ctx.Done():
		stop()
		logger.Printf("shutdown signal received, draining http connections")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// TODO(verify): websocket connections are hijacked by khatru, so
		// http.Server.Shutdown does not wait for them; they die when the
		// process exits right after this. Add a connection drain if a pilot
		// ever needs zero-downtime restarts.
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		return nil
	}
}

// runReindex needs only the SCRUTINY_DATA_DIR environment: the full relay
// configuration (service url, allowlist, ...) is not required for maintenance.
func runReindex(logger *log.Logger) error {
	paths, err := config.PathsFromEnv(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	logger.Printf("reindexing: base store %s -> search index %s", paths.BaseDBPath, paths.SearchIndexPath)
	replayed, err := store.Reindex(paths.BaseDBPath, paths.SearchIndexPath, logger)
	if err != nil {
		return err
	}
	logger.Printf("reindex complete: replayed %d events from the base store", replayed)
	return nil
}
