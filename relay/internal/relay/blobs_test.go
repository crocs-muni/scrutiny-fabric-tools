// Unit tests for the transport-level half of the Blossom surface (issue #123,
// docs/specs/mcp-publishing.md §9.4): the body-cap exemption that lets a
// 50 MB upload reach the relay, and the GET-by-hash headers produced inside
// Hardened before khatru's router is consulted. The end-to-end behaviour is
// covered by relay/integration_test.go.
package relay

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fiatjaf.com/nostr"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
)

// writeStoredBlob lays a blob body down where §9.4 puts it.
func writeStoredBlob(t *testing.T, cfg config.Config, body []byte) string {
	t.Helper()

	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	dir := filepath.Join(cfg.DataDir, "blobs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating the blob directory %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash), body, 0o644); err != nil {
		t.Fatalf("writing the blob %s: %v", hash, err)
	}
	sidecar, err := json.Marshal(struct {
		Size     int    `json:"size"`
		Uploader string `json:"uploader"`
	}{Size: len(body), Uploader: strings.Repeat("0", 64)})
	if err != nil {
		t.Fatalf("marshaling the sidecar for %s: %v", hash, err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash+".json"), sidecar, 0o644); err != nil {
		t.Fatalf("writing the sidecar for %s: %v", hash, err)
	}
	return hash
}

// TestHardenedServesBlobByHash pins the GET policy: lookup by hash only, the
// requested extension is a filename decoration, non-images are attachments
// with nosniff, PNG stays inline, and absent hashes are 404.
func TestHardenedServesBlobByHash(t *testing.T) {
	cfg := config.Config{
		Paths: config.Paths{DataDir: t.TempDir()},
	}
	cfg.BlobMaxBytes = config.DefaultBlobMaxBytes

	text := []byte("# scrutiny artifact\n\nserved by hash\n")
	textHash := writeStoredBlob(t, cfg, text)
	png := []byte("\x89PNG\r\n\x1a\n")
	pngHash := writeStoredBlob(t, cfg, png)
	absent := strings.Repeat("b", 64)

	h := Hardened(http.NotFoundHandler(), cfg)

	cases := []struct {
		name             string
		path             string
		wantStatus       int
		wantBody         []byte
		wantDisposition  string // "attachment" / "inline" prefix
		wantFilenamePart string
		wantNoSniff      bool
	}{
		{name: "no extension", path: "/" + textHash, wantStatus: http.StatusOK,
			wantBody: text, wantDisposition: "attachment", wantFilenamePart: textHash, wantNoSniff: true},
		{name: "requested extension", path: "/" + textHash + ".pdf", wantStatus: http.StatusOK,
			wantBody: text, wantDisposition: "attachment", wantFilenamePart: textHash + ".pdf", wantNoSniff: true},
		{name: "wrong extension", path: "/" + textHash + ".zip", wantStatus: http.StatusOK,
			wantBody: text, wantDisposition: "attachment", wantFilenamePart: textHash + ".zip", wantNoSniff: true},
		{name: "png inline", path: "/" + pngHash + ".png", wantStatus: http.StatusOK,
			wantBody: png, wantDisposition: "inline", wantFilenamePart: pngHash + ".png"},
		{name: "absent", path: "/" + absent, wantStatus: http.StatusNotFound},
		{name: "absent with extension", path: "/" + absent + ".pdf", wantStatus: http.StatusNotFound},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))

			if rec.Code != tc.wantStatus {
				t.Fatalf("GET %s: status %d, want %d (body %q)", tc.path, rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}
			if !bytes.Equal(rec.Body.Bytes(), tc.wantBody) {
				t.Fatalf("GET %s: body %q, want the stored bytes", tc.path, rec.Body.Bytes())
			}
			cd := rec.Header().Get("Content-Disposition")
			if !strings.HasPrefix(cd, tc.wantDisposition) {
				t.Fatalf("GET %s: Content-Disposition = %q, want the %q disposition", tc.path, cd, tc.wantDisposition)
			}
			if !strings.Contains(cd, tc.wantFilenamePart) {
				t.Fatalf("GET %s: Content-Disposition = %q, want the filename to carry %q", tc.path, cd, tc.wantFilenamePart)
			}
			if got := rec.Header().Get("X-Content-Type-Options"); tc.wantNoSniff && got != "nosniff" {
				t.Fatalf("GET %s: X-Content-Type-Options = %q, want nosniff", tc.path, got)
			}
		})
	}
}

// TestHardenedAnswersEveryKhatruBlobPath pins the routing split against the
// blocker: khatru's blob route (khatru/blossom/server.go:62) also accepts an
// empty extension ("/<sha>.") and an extension longer than blobExtMaxLen or
// with characters parseBlobPath refuses. If Hardened tested parseBlobPath, those
// GETs would reach khatru, which serves the stored bytes with a sniffed
// Content-Type and no Content-Disposition — an uploaded HTML artifact would run
// in the relay's origin. Every such path must be answered here, by hash, with
// the extension dropped from the filename.
func TestHardenedAnswersEveryKhatruBlobPath(t *testing.T) {
	cfg := config.Config{
		Paths: config.Paths{DataDir: t.TempDir()},
	}
	cfg.BlobMaxBytes = config.DefaultBlobMaxBytes

	// Real HTML, so the sniffed type is the one that would execute.
	html := []byte("<!doctype html><script>alert(document.domain)</script>\n")
	htmlHash := writeStoredBlob(t, cfg, html)
	png := []byte("\x89PNG\r\n\x1a\n")
	pngHash := writeStoredBlob(t, cfg, png)
	absent := strings.Repeat("b", 64)
	nonHash := strings.Repeat("z", 64)

	// Extensions parseBlobPath rejects but khatru's route accepts: an empty
	// one, one past blobExtMaxLen (khatru accepts any length), and one with a
	// character that may not appear in the quoted filename.
	exts := []struct{ name, ext string }{
		{name: "empty extension", ext: "."},
		{name: "long extension", ext: "." + strings.Repeat("x", blobExtMaxLen+4)},
		{name: "unsafe extension", ext: ".p+df"},
	}

	// Any response from this handler is the pre-fix behaviour: the blob GET
	// slipped past Hardened's blob branch to khatru.
	reached := false
	h := Hardened(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusTeapot)
	}), cfg)

	type testCase struct {
		name            string
		path            string
		upgrade         bool // send "Upgrade: websocket", which must not bypass the blob branch
		wantStatus      int
		wantBody        []byte
		wantDisposition string // "attachment" / "inline" prefix
		wantFilename    string // exact "filename=..." suffix
		wantContentType string // prefix
		wantNoSniff     bool
	}
	cases := []testCase{
		{name: "non-hash with empty extension", path: "/" + nonHash + ".", wantStatus: http.StatusNotFound},
		{name: "absent with empty extension", path: "/" + absent + ".", wantStatus: http.StatusNotFound},
		{name: "absent with long extension", path: "/" + absent + exts[1].ext, wantStatus: http.StatusNotFound},
	}
	for _, e := range exts {
		cases = append(cases,
			testCase{name: "html " + e.name, path: "/" + htmlHash + e.ext, wantStatus: http.StatusOK,
				wantBody: html, wantDisposition: "attachment",
				wantFilename: `filename="` + htmlHash + `"`, wantContentType: "text/html", wantNoSniff: true},
			testCase{name: "png " + e.name, path: "/" + pngHash + e.ext, wantStatus: http.StatusOK,
				wantBody: png, wantDisposition: "inline",
				wantFilename: `filename="` + pngHash + `"`, wantContentType: "image/png"},
		)
	}
	cases = append(cases,
		testCase{name: "html empty extension with upgrade header", path: "/" + htmlHash + ".", upgrade: true,
			wantStatus: http.StatusOK, wantBody: html, wantDisposition: "attachment",
			wantFilename: `filename="` + htmlHash + `"`, wantContentType: "text/html", wantNoSniff: true},
		testCase{name: "png long extension with upgrade header", path: "/" + pngHash + exts[1].ext, upgrade: true,
			wantStatus: http.StatusOK, wantBody: png, wantDisposition: "inline",
			wantFilename: `filename="` + pngHash + `"`, wantContentType: "image/png"},
	)

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached = false
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.upgrade {
				req.Header.Set("Upgrade", "websocket")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if reached {
				t.Fatalf("GET %s reached khatru: khatru would serve the stored bytes without the download headers", tc.path)
			}
			if rec.Code != tc.wantStatus {
				t.Fatalf("GET %s: status %d, want %d (body %q)", tc.path, rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}
			if !bytes.Equal(rec.Body.Bytes(), tc.wantBody) {
				t.Fatalf("GET %s: body %q, want the stored bytes", tc.path, rec.Body.Bytes())
			}
			cd := rec.Header().Get("Content-Disposition")
			if !strings.HasPrefix(cd, tc.wantDisposition) {
				t.Fatalf("GET %s: Content-Disposition = %q, want the %q disposition", tc.path, cd, tc.wantDisposition)
			}
			if !strings.HasSuffix(cd, tc.wantFilename) {
				t.Fatalf("GET %s: Content-Disposition = %q, want the filename to be %q", tc.path, cd, tc.wantFilename)
			}
			if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, tc.wantContentType) {
				t.Fatalf("GET %s: Content-Type = %q, want %q", tc.path, ct, tc.wantContentType)
			}
			got := rec.Header().Get("X-Content-Type-Options")
			if tc.wantNoSniff && got != "nosniff" {
				t.Fatalf("GET %s: X-Content-Type-Options = %q, want nosniff", tc.path, got)
			}
			if !tc.wantNoSniff && got != "" {
				t.Fatalf("GET %s: X-Content-Type-Options = %q, want it absent for an inline image", tc.path, got)
			}
		})
	}
}

// TestHardenedBodyCapExemptsBlobUpload pins the split from §9.4: /upload
// bodies are not clipped at the 64 KiB transport cap, every other non-websocket
// body still is.
func TestHardenedBodyCapExemptsBlobUpload(t *testing.T) {
	cfg := config.Config{BlobMaxBytes: config.DefaultBlobMaxBytes}

	type readResult struct {
		path string
		n    int
		err  error
	}
	var reads []readResult
	h := Hardened(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		reads = append(reads, readResult{path: r.URL.Path, n: len(body), err: err})
	}), cfg)

	big := bytes.Repeat([]byte{'x'}, maxRequestBodyBytes+1)

	upload := httptest.NewRequest(http.MethodPut, "/upload", bytes.NewReader(big))
	h.ServeHTTP(httptest.NewRecorder(), upload)
	if len(reads) != 1 {
		t.Fatalf("PUT /upload: handler saw %d bodies, want 1", len(reads))
	}
	if reads[0].err != nil {
		t.Fatalf("PUT /upload (%d bytes): body read stopped after %d bytes: %v", len(big), reads[0].n, reads[0].err)
	}
	if reads[0].n != len(big) {
		t.Fatalf("PUT /upload: read %d of %d bytes, want the full body", reads[0].n, len(big))
	}

	reads = nil
	other := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(big))
	h.ServeHTTP(httptest.NewRecorder(), other)
	if len(reads) != 1 {
		t.Fatalf("POST /: handler saw %d bodies, want 1", len(reads))
	}
	var maxErr *http.MaxBytesError
	if !errors.As(reads[0].err, &maxErr) {
		t.Fatalf("POST / (%d bytes): reading the body returned %v, want *http.MaxBytesError", len(big), reads[0].err)
	}
	if maxErr.Limit != maxRequestBodyBytes {
		t.Fatalf("POST /: body cap = %d, want %d", maxErr.Limit, maxRequestBodyBytes)
	}
}

// TestBlobMaxBytesFromEnv pins the configuration surface of the cap: the
// default is 50 MiB and SCRUTINY_BLOB_MAX_BYTES overrides it.
func TestBlobMaxBytesFromEnv(t *testing.T) {
	base := map[string]string{
		config.EnvDataDir:        t.TempDir(),
		config.EnvServiceURL:     "wss://relay.example.com",
		config.EnvAllowedPubkeys: nostr.Generate().Public().Hex(),
	}
	load := func(extra map[string]string) (config.Config, error) {
		env := make(map[string]string, len(base)+len(extra))
		for k, v := range base {
			env[k] = v
		}
		for k, v := range extra {
			env[k] = v
		}
		return config.FromEnv(config.LookupFromMap(env))
	}

	cfg, err := load(nil)
	if err != nil {
		t.Fatalf("config.FromEnv without %s: %v", config.EnvBlobMaxBytes, err)
	}
	if cfg.BlobMaxBytes != config.DefaultBlobMaxBytes {
		t.Fatalf("BlobMaxBytes default = %d, want %d", cfg.BlobMaxBytes, config.DefaultBlobMaxBytes)
	}

	cfg, err = load(map[string]string{config.EnvBlobMaxBytes: "1048576"})
	if err != nil {
		t.Fatalf("config.FromEnv with %s=1048576: %v", config.EnvBlobMaxBytes, err)
	}
	if cfg.BlobMaxBytes != 1<<20 {
		t.Fatalf("BlobMaxBytes = %d, want %d", cfg.BlobMaxBytes, 1<<20)
	}

	if _, err := load(map[string]string{config.EnvBlobMaxBytes: "not-a-number"}); err == nil {
		t.Fatalf("config.FromEnv with a non-numeric %s accepted it, want an error", config.EnvBlobMaxBytes)
	}
}
