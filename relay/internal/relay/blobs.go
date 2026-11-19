package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nipb7/blossom"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/gate"
)

// Blob refusal reasons. They keep the "blocked: " prefix khatru passes through
// unchanged (in the X-Reason header of an HTTP error), so the client reports
// the relay's words verbatim (spec §10).
const (
	// msgBlobTooLarge is formatted with the configured cap.
	msgBlobTooLarge = "blocked: blob exceeds %d bytes"
	// msgBlobList answers /list/<pubkey>, which this relay does not index.
	msgBlobList = "blocked: /list is not supported"
	// msgBlobPermanent answers every DELETE.
	msgBlobPermanent = "blocked: blobs are permanent"
)

// blobExtMaxLen caps the extension a download URL may name, so the
// Content-Disposition filename stays a filename.
const blobExtMaxLen = 16

// blobDir is the directory holding blob bodies and their sidecars. It sits
// inside the data volume, so blobs live and die with the relay's data.
func blobDir(cfg config.Config) string {
	return filepath.Join(cfg.DataDir, "blobs")
}

// blobMaxBytes is the configured upload cap, or the documented default when a
// hand-built config left the field at zero (config.FromEnv always sets it).
// Without this, a zero-valued Config would refuse every upload.
func blobMaxBytes(cfg config.Config) int64 {
	if cfg.BlobMaxBytes > 0 {
		return cfg.BlobMaxBytes
	}
	return config.DefaultBlobMaxBytes
}

// blobServiceURL is the http(s) base of a blob's public URL. The relay is
// configured with a ws(s):// URL (it is also the NIP-42 challenge tag), while
// blobs are fetched over http(s); only the scheme differs.
func blobServiceURL(serviceURL string) string {
	switch {
	case strings.HasPrefix(serviceURL, "wss://"):
		return "https://" + strings.TrimPrefix(serviceURL, "wss://")
	case strings.HasPrefix(serviceURL, "ws://"):
		return "http://" + strings.TrimPrefix(serviceURL, "ws://")
	default:
		return serviceURL
	}
}

// blobBodyPath is the file holding the raw bytes of a blob.
func blobBodyPath(dir, sha string) string {
	return filepath.Join(dir, sha)
}

// blobSidecarPath is the sidecar describing a blob: its size and uploader.
func blobSidecarPath(dir, sha string) string {
	return filepath.Join(dir, sha+".json")
}

// isBlobHash reports whether s is a lowercase sha256 hex digest, i.e. the only
// name a blob can have on disk (khatru computes it from the bytes).
func isBlobHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// isBlobExtChar reports whether c may appear in the extension of a blob URL.
// The extension ends up in a Content-Disposition filename, so only characters
// that cannot terminate the quoted string or smuggle anything into the header
// are allowed.
func isBlobExtChar(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	case c == '.' || c == '-' || c == '_':
		return true
	}
	return false
}

// parseBlobPath splits "/<sha256>[.<ext>]" into the hash and the requested
// extension (with its leading dot, or empty). Anything else — nested paths,
// "/list/<pubkey>", an extension that is not a filename suffix — is not a blob
// path.
func parseBlobPath(p string) (sha, ext string, ok bool) {
	if len(p) < 1+64 || p[0] != '/' {
		return "", "", false
	}
	sha = p[1:65]
	if !isBlobHash(sha) {
		return "", "", false
	}
	rest := p[65:]
	if rest == "" {
		return sha, "", true
	}
	if rest[0] != '.' || len(rest) < 2 || len(rest) > 1+blobExtMaxLen {
		return "", "", false
	}
	for _, c := range rest[1:] {
		if !isBlobExtChar(c) {
			return "", "", false
		}
	}
	return sha, rest, true
}

// isKhatruBlobPath mirrors khatru's blob route condition exactly
// (khatru/blossom/server.go:62): a 65-byte path, or one whose first dot sits at
// index 65 (i.e. "/<64 bytes>.<anything>"), with no further slash. It is
// deliberately not parseBlobPath: a stricter test would forward "/<sha>." and
// extensions longer than blobExtMaxLen to khatru, which serves the raw bytes as
// text/html without Content-Disposition or nosniff — an uploaded HTML artifact
// would then run in the relay's origin.
func isKhatruBlobPath(p string) bool {
	return (len(p) == 65 || strings.Index(p, ".") == 65) && strings.Index(p[1:], "/") == -1
}

// storeBlob stores body under <dir>/<sha256>, atomically and idempotently.
//
// The name is the SHA-256 of the content, so a file of the right size under
// that name already is that content: a second upload of the same bytes writes
// nothing. Everything written goes through a temp file and a rename, so two
// concurrent uploads of the same hash can only replace a complete file with an
// identical one.
//
// khatru's detected extension is not part of the record: a blob is addressed
// by its hash whichever extension a reader asks for, and the relay serves the
// stored bytes with a sniffed media type (spec §9.4: no MIME or extension
// policy on the relay).
func storeBlob(dir, sha string, body []byte) error {
	if !isBlobHash(sha) {
		return fmt.Errorf("blob: %q is not a sha256 hex digest", sha)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("blob: creating %s: %w", dir, err)
	}
	final := blobBodyPath(dir, sha)
	if info, err := os.Stat(final); err == nil && info.Size() == int64(len(body)) {
		return nil
	}
	if err := writeFileAtomic(dir, final, body); err != nil {
		return fmt.Errorf("blob: writing %s: %w", final, err)
	}
	return nil
}

// writeFileAtomic writes payload to path through a temp file in the same
// directory, so a reader (or a crash) never observes a partial file.
func writeFileAtomic(dir, path string, payload []byte) error {
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	// After a successful rename this removes nothing; on every other path it
	// drops the partial temp file.
	defer os.Remove(tmp.Name())

	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// loadBlob opens the stored bytes of a hash for khatru's GET path; the
// attachment middleware normally answers GET first. A missing blob is a
// not-exist error, which khatru answers with 404.
func loadBlob(dir, sha string) (io.ReadSeeker, *url.URL, error) {
	if !isBlobHash(sha) {
		return nil, nil, os.ErrNotExist
	}
	body, err := os.Open(blobBodyPath(dir, sha))
	if err != nil {
		return nil, nil, err
	}
	return body, nil, nil
}

// blobSize reports the size of the stored bytes of a hash, and whether they
// are stored at all.
func blobSize(dir, sha string) (int64, bool) {
	if !isBlobHash(sha) {
		return 0, false
	}
	info, err := os.Stat(blobBodyPath(dir, sha))
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.Size(), true
}

// hasBlob reports whether the bytes of a hash are stored.
func hasBlob(dir, sha string) bool {
	_, ok := blobSize(dir, sha)
	return ok
}

// blobSidecar is the small per-blob record next to the bytes (spec §9.4
// "Index"). It is advisory: the bytes are the blob, so a missing or unreadable
// sidecar never fails a read.
type blobSidecar struct {
	Size     int64  `json:"size"`
	Uploader string `json:"uploader"`
}

// writeBlobSidecar records an upload. khatru calls this (through Keep) before
// StoreBlob, so a sidecar can describe a body whose write failed; readers
// therefore look at the stored bytes first.
func writeBlobSidecar(dir, sha string, size int64, uploader nostr.PubKey) error {
	if !isBlobHash(sha) {
		return fmt.Errorf("blob: %q is not a sha256 hex digest", sha)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("blob: creating %s: %w", dir, err)
	}
	payload, err := json.Marshal(blobSidecar{Size: size, Uploader: uploader.Hex()})
	if err != nil {
		return fmt.Errorf("blob: encoding the sidecar of %s: %w", sha, err)
	}
	if err := writeFileAtomic(dir, blobSidecarPath(dir, sha), payload); err != nil {
		return fmt.Errorf("blob: writing the sidecar of %s: %w", sha, err)
	}
	return nil
}

// readBlobSidecar returns the sidecar of a hash, or a zero record when it is
// missing, unreadable or corrupt: nothing about a blob's bytes depends on it.
func readBlobSidecar(dir, sha string) blobSidecar {
	payload, err := os.ReadFile(blobSidecarPath(dir, sha))
	if err != nil {
		return blobSidecar{}
	}
	var sidecar blobSidecar
	if err := json.Unmarshal(payload, &sidecar); err != nil {
		return blobSidecar{}
	}
	return sidecar
}

// sniffSeeker reports the media type of the bytes at the start of rs and
// leaves rs positioned at the start again for the response body.
func sniffSeeker(rs io.ReadSeeker) (string, error) {
	head := make([]byte, 512)
	n, err := rs.Read(head)
	if err != nil && err != io.EOF {
		return "", err
	}
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return http.DetectContentType(head[:n]), nil
}

// sniffBlobType is the media type khatru's HEAD advertises for a stored blob,
// sniffed from its bytes rather than from the upload's filename. An unreadable
// file falls back to the generic type; GET sniffs the same way and reports its
// own read error.
func sniffBlobType(dir, sha string) string {
	body, err := os.Open(blobBodyPath(dir, sha))
	if err != nil {
		return "application/octet-stream"
	}
	defer body.Close()
	contentType, err := sniffSeeker(body)
	if err != nil {
		return "application/octet-stream"
	}
	return contentType
}

// blobIndex is khatru's BlobIndex over the blob directory: the directory *is*
// the index, so nothing is recorded twice and a restart changes nothing. It is
// deliberately not EventStoreBlobIndexWrapper, which writes unsigned kind-24242
// records into the main event store where public REQ would serve them (spec
// §9.4 "Index").
type blobIndex struct {
	dir string
}

// Keep records the descriptor of the upload in flight: the sidecar with the
// size and the uploader. khatru calls it before StoreBlob.
func (i blobIndex) Keep(_ context.Context, bd blossom.BlobDescriptor, uploader nostr.PubKey) error {
	return writeBlobSidecar(i.dir, bd.SHA256, int64(bd.Size), uploader)
}

// Get describes a stored blob for khatru's HEAD. A hash that is not stored is
// (nil, nil), which khatru answers with 404 — an error here would turn every
// miss into a 500.
func (i blobIndex) Get(_ context.Context, sha string) (*blossom.BlobDescriptor, error) {
	size, ok := blobSize(i.dir, sha)
	if !ok {
		return nil, nil
	}
	return &blossom.BlobDescriptor{
		SHA256: sha,
		Size:   int(size),
		Type:   sniffBlobType(i.dir, sha),
	}, nil
}

// List yields the blobs whose sidecar names pubkey as the uploader. /list is
// refused (blobRejectList), so this only completes the interface; it reads the
// directory rather than a second copy of it.
func (i blobIndex) List(_ context.Context, pubkey nostr.PubKey) iter.Seq[blossom.BlobDescriptor] {
	return func(yield func(blossom.BlobDescriptor) bool) {
		for _, stored := range i.listStored() {
			if stored.uploader != pubkey {
				continue
			}
			if !yield(stored.descriptor) {
				return
			}
		}
	}
}

// ListAllBlobs yields every stored blob with its uploader. Unreachable over
// HTTP (/list is refused); part of khatru's BlobIndex.
func (i blobIndex) ListAllBlobs(_ context.Context) iter.Seq2[nostr.PubKey, blossom.BlobDescriptor] {
	return func(yield func(nostr.PubKey, blossom.BlobDescriptor) bool) {
		for _, stored := range i.listStored() {
			if !yield(stored.uploader, stored.descriptor) {
				return
			}
		}
	}
}

// OwnersForBlob reports the sidecar's uploader, when that blob is stored.
func (i blobIndex) OwnersForBlob(_ context.Context, sha string) []nostr.PubKey {
	if !hasBlob(i.dir, sha) {
		return nil
	}
	pubkey, err := nostr.PubKeyFromHex(readBlobSidecar(i.dir, sha).Uploader)
	if err != nil {
		return nil
	}
	return []nostr.PubKey{pubkey}
}

// Delete refuses: blobs are as permanent as the events citing them, and
// blobRejectDelete stops every request before khatru can call this. It reports
// the refusal rather than pretending to have deleted anything.
func (i blobIndex) Delete(_ context.Context, sha string, _ nostr.PubKey) error {
	return fmt.Errorf("blob: deletes are refused by policy (%s)", sha)
}

// storedBlob is one entry of the blob directory: its descriptor and the
// uploader recorded in its sidecar.
type storedBlob struct {
	descriptor blossom.BlobDescriptor
	uploader   nostr.PubKey
}

// listStored reads the directory, skipping sidecars and in-flight temp files
// as well as blobs whose uploader is unknown. It reports (nil) when the
// directory does not exist yet, i.e. before the first upload.
func (i blobIndex) listStored() []storedBlob {
	entries, err := os.ReadDir(i.dir)
	if err != nil {
		return nil
	}
	out := make([]storedBlob, 0, len(entries))
	for _, entry := range entries {
		sha := entry.Name()
		if entry.IsDir() || !isBlobHash(sha) {
			continue
		}
		size, ok := blobSize(i.dir, sha)
		if !ok {
			continue
		}
		uploader, err := nostr.PubKeyFromHex(readBlobSidecar(i.dir, sha).Uploader)
		if err != nil {
			continue
		}
		out = append(out, storedBlob{
			descriptor: blossom.BlobDescriptor{
				SHA256: sha,
				Size:   int(size),
				Type:   sniffBlobType(i.dir, sha),
			},
			uploader: uploader,
		})
	}
	return out
}

// serveBlobAttachment answers GET /<sha256>[.<ext>] from the blob directory,
// in front of khatru so the response carries the headers a download needs:
//
//   - the bytes are addressed by the hash: the requested extension is ignored
//     for the lookup and only names the downloaded file;
//   - everything but PNG and JPEG is sent as an attachment with
//     X-Content-Type-Options: nosniff, so an uploaded .html or .svg can never
//     be interpreted as active content in the relay's origin. PNG and JPEG stay
//     inline so image links render (spec §9.4);
//   - an absent blob is a 404, exactly like HEAD;
//   - a path khatru would answer as a blob but parseBlobPath rejects (an empty
//     extension, an extension past blobExtMaxLen, characters not allowed in a
//     filename) still resolves by its hash, with the extension dropped: it is
//     never forwarded to khatru, which would send the bare bytes.
func serveBlobAttachment(w http.ResponseWriter, r *http.Request, cfg config.Config) {
	sha, ext, ok := parseBlobPath(r.URL.Path)
	if !ok {
		// khatru's blob route is wider than parseBlobPath (isKhatruBlobPath
		// explains why a subset is unsafe). Answer such a path by the hash
		// khatru would look up — the 64 bytes after the slash, with an empty
		// extension — or 404 when they are not a sha256. It is never forwarded
		// to khatru, which would send the bare bytes.
		if !isKhatruBlobPath(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		sha = r.URL.Path[1:65]
		if !isBlobHash(sha) {
			http.NotFound(w, r)
			return
		}
	}
	body, err := os.Open(blobBodyPath(blobDir(cfg), sha))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer body.Close()

	info, err := body.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	contentType, err := sniffSeeker(body)
	if err != nil {
		http.Error(w, "cannot read the stored blob", http.StatusInternalServerError)
		return
	}

	name := sha + ext
	switch contentType {
	case "image/png", "image/jpeg":
		w.Header().Set("Content-Disposition", `inline; filename="`+name+`"`)
	default:
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	w.Header().Set("Content-Type", contentType)
	// Content-addressed: the bytes behind a hash never change, so the response
	// is immutable (the same headers khatru's own GET sets).
	w.Header().Set("ETag", `"`+sha+`"`)
	w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
	// A zero modtime suppresses Last-Modified: the file's mtime records when
	// the relay received the bytes, which says nothing about the content.
	http.ServeContent(w, r, name, time.Time{}, body)
}

// blobRejectUpload is the upload gate: the uploader must be on the publisher
// allowlist and the body within cfg.BlobMaxBytes. No MIME or extension check
// happens here on purpose (spec §9.4): khatru sniffs the bytes and would
// misjudge legitimate Markdown, CSV or JSON.
func blobRejectUpload(cfg config.Config) func(context.Context, *nostr.Event, int, string) (bool, string, int) {
	allowed := make(map[nostr.PubKey]struct{}, len(cfg.AllowedPubkeys))
	for _, pubkey := range cfg.AllowedPubkeys {
		allowed[pubkey] = struct{}{}
	}
	maxBytes := blobMaxBytes(cfg)
	return func(_ context.Context, auth *nostr.Event, size int, _ string) (bool, string, int) {
		// khatru answers a missing Authorization header itself; this guard
		// only keeps another call path from dereferencing nil here.
		if auth == nil {
			return true, gate.MsgNotAllowed, http.StatusForbidden
		}
		if _, ok := allowed[auth.PubKey]; !ok {
			return true, gate.MsgNotAllowed, http.StatusForbidden
		}
		if int64(size) > maxBytes {
			return true, fmt.Sprintf(msgBlobTooLarge, maxBytes), http.StatusRequestEntityTooLarge
		}
		return false, "", 0
	}
}

// blobRejectGet allows every GET: blobs are public artifacts cited by public
// events (spec §9.4 "RejectGet | Allow").
func blobRejectGet(context.Context, *nostr.Event, string, string) (bool, string, int) {
	return false, "", 0
}

// blobRejectList refuses /list/<pubkey>: this relay does not index blobs by
// publisher, and the listing would hand out uploader identities. Hardened
// answers 404 for the route before khatru sees it; this hook keeps the relay
// from listing anything when Bundle.Relay is mounted without that wrapper.
func blobRejectList(context.Context, *nostr.Event, nostr.PubKey) (bool, string, int) {
	return true, msgBlobList, http.StatusNotFound
}

// blobRejectDelete refuses every delete: blobs are as permanent as the events
// citing them (spec §9.4 "RejectDelete | Always reject").
func blobRejectDelete(context.Context, *nostr.Event, string, string) (bool, string, int) {
	return true, msgBlobPermanent, http.StatusForbidden
}
