// Package relay — landing.go serves the human-facing HTML page at "/".
package relay

import (
	"fmt"
	"html/template"
	"net/http"
	"strings"

	"fiatjaf.com/nostr/nip11"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
)

// landingTemplate is the hand-written, deliberately unstyled page served at
// GET /. It says what this relay is, points humans at scrutiny-lens, and lists
// the same facts NIP-11 publishes. Nothing is auto-derived beyond the fields
// below; when NIP-11 or the config gains a field worth showing, add it here
// by hand.
var landingTemplate = template.Must(template.New("landing").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>scrutiny relay</title>
</head>
<body>
<h1>scrutiny relay</h1>

<p>
This is the nostr <a href="https://github.com/crocs-muni/scrutiny-fabric">SCRUTINY</a> relay,
part of <a href="https://scrutiny.cloud/">scrutiny.cloud</a>.
We recommend using the
<a href="https://crocs-muni.github.io/scrutiny-lens/">SCRUTINY Lens</a> client,
the reference reader for SCRUTINY Fabric data.
</p>

<dl>
<dt>relay</dt><dd><code>{{.ServiceURL}}</code></dd>
<dt>contact</dt><dd>{{.Contact}}</dd>
<dt>policy</dt><dd>reads are open; publishing requires NIP-42 auth as an invited key</dd>
<dt>vocabulary</dt><dd>{{.AcceptedTags}}</dd>
<dt>NIPs</dt><dd>{{.NIPs}}</dd>
<dt>software</dt><dd><a href="https://github.com/crocs-muni/scrutiny-fabric-tools/tree/main/relay">scrutiny-fabric relay</a> {{.Version}} on <a href="https://khatru.nostr.technology/">khatru</a></dd>
</dl>

<hr>
<p><small><a href="https://github.com/crocs-muni/scrutiny-fabric-tools">source</a></small></p>
</body>
</html>
`))

// nipLinkBase is the canonical NIP text source; NIP numbers are zero-padded
// in file names (01.md, 42.md, ...).
const nipLinkBase = "https://github.com/nostr-protocol/nips/blob/master/"

// NewLandingHandler builds the GET / handler served behind khatru's router.
// cfg supplies the anchor values; infoDoc returns the live NIP-11 document so
// the NIP list cannot disagree with what clients see at
// Accept: application/nostr+json.
func NewLandingHandler(cfg config.Config, infoDoc func() nip11.RelayInformationDocument) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		doc := infoDoc()

		// Render the NIP list as links once per request: OverwriteRelay-
		// Information rebuilds info.SupportedNIPs per request, so the
		// landing page reads it fresh instead of caching a copy.
		nips := make([]string, 0, len(doc.SupportedNIPs))
		for _, v := range doc.SupportedNIPs {
			n := fmt.Sprint(v)
			href := nipLinkBase + fmt.Sprintf("%02s", n) + ".md"
			nips = append(nips, `<a href="`+href+`">`+template.HTMLEscapeString(n)+`</a>`)
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = landingTemplate.Execute(w, struct {
			ServiceURL   string
			Contact      string
			AcceptedTags string
			NIPs         template.HTML
			Version      string
		}{
			ServiceURL:   cfg.ServiceURL,
			Contact:      cfg.RelayContact,
			AcceptedTags: strings.Join(canonicalVocabulary(cfg.AcceptedTags), ", "),
			NIPs:         template.HTML(strings.Join(nips, ", ")),
			Version:      Version,
		})
	})
}

// canonicalVocabulary strips the -test/-pilot/-demo twins from the accepted
// tag list: the landing page shows the canonical vocabulary, NIP-11's
// posting_policy carries the full accepted set.
func canonicalVocabulary(tags []string) []string {
	out := make([]string, 0, len(tags))
	for _, t := range tags {
		if !strings.HasSuffix(t, "-test") && !strings.HasSuffix(t, "-pilot") && !strings.HasSuffix(t, "-demo") {
			out = append(out, t)
		}
	}
	return out
}
