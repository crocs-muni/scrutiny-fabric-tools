// Command relay runs the scrutiny-fabric pilot relay.
//
// Usage:
//
//	relay            run the relay (configuration from the SCRUTINY_* environment)
//	relay reindex    wipe the bleve search index and replay the base store into it
//	relay import     store an NDJSON event corpus offline, bypassing the write gate
//	relay count      print how many events the base store holds, per kind
//	relay diff       write the events this store has and another one lacks
//
// The environment is documented in the repository README.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"fiatjaf.com/nostr"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/relay"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/store"
)

const usageTemplate = "usage: %s [reindex | count | diff -other BASE.bolt [-out FILE.ndjson] | import -in FILE.ndjson [-verify=false]]\n"

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
		case "import":
			if err := runImport(logger, args[1:]); err != nil {
				logger.Printf("import failed: %v", err)
				os.Exit(1)
			}
			return
		case "count":
			if err := runCount(logger); err != nil {
				logger.Printf("count failed: %v", err)
				os.Exit(1)
			}
			return
		case "diff":
			if err := runDiff(logger, args[1:]); err != nil {
				logger.Printf("diff failed: %v", err)
				os.Exit(1)
			}
			return
		case "help", "-h", "--help":
			fmt.Fprintf(os.Stderr, usageTemplate, os.Args[0])
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown subcommand %q\n", args[0])
			fmt.Fprintf(os.Stderr, usageTemplate, os.Args[0])
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

// runImport needs only the SCRUTINY_DATA_DIR environment, like reindex: the
// event corpus is the authority, so the service URL and the publisher
// allowlist play no part in it.
func runImport(logger *log.Logger, args []string) error {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	in := flags.String("in", "", "NDJSON file of signed events to store (required)")
	verify := flags.Bool("verify", true, "verify each event id and signature before storing it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *in == "" {
		return errors.New("import: -in <file.ndjson> is required")
	}

	paths, err := config.PathsFromEnv(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	logger.Printf("importing: %s -> base store %s, search index %s (verify=%t)", *in, paths.BaseDBPath, paths.SearchIndexPath, *verify)
	summary, err := store.ImportNDJSON(*in, paths.BaseDBPath, paths.SearchIndexPath, *verify, logger)
	if err != nil {
		return fmt.Errorf("stopped after %d events read (%d stored, %d duplicates): %w", summary.Read, summary.Imported, summary.Duplicates, err)
	}
	logger.Printf("import complete: read %d events, stored %d, duplicates %d", summary.Read, summary.Imported, summary.Duplicates)
	return nil
}

// runCount prints how many events the base store holds, per kind. Like import
// and reindex it needs only SCRUTINY_DATA_DIR, and it refuses to run while a
// relay owns the store (the boltdb open times out).
func runCount(logger *log.Logger) error {
	paths, err := config.PathsFromEnv(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	total, perKind, err := store.Count(paths.BaseDBPath)
	if err != nil {
		return err
	}

	kinds := make([]int, 0, len(perKind))
	for kind := range perKind {
		kinds = append(kinds, int(kind))
	}
	sort.Ints(kinds)
	for _, kind := range kinds {
		fmt.Printf("kind %d: %d\n", kind, perKind[nostr.Kind(kind)])
	}
	fmt.Printf("events: %d\n", total)
	return nil
}

// runDiff writes the events this store holds that -other lacks, as NDJSON that
// `relay import` can consume. Needs only SCRUTINY_DATA_DIR plus the other
// store's base.bolt path; both stores must be closed in any relay process.
func runDiff(logger *log.Logger, args []string) error {
	flags := flag.NewFlagSet("diff", flag.ContinueOnError)
	other := flags.String("other", "", "base.bolt of the store to compare against (required)")
	out := flags.String("out", "diff.ndjson", "NDJSON file that receives the missing events")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *other == "" {
		return errors.New("diff: -other <path/to/base.bolt> is required")
	}

	paths, err := config.PathsFromEnv(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	missing, compared, err := store.Diff(paths.BaseDBPath, *other, *out)
	if err != nil {
		return fmt.Errorf("stopped after %d missing of %d compared: %w", missing, compared, err)
	}
	logger.Printf("diff: %d of %d events in %s are missing from %s -> %s", missing, compared, paths.BaseDBPath, *other, *out)
	return nil
}
