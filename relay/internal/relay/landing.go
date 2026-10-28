// landing.go serves the human-facing HTML page at "/".
package relay

import (
	"bytes"
	"fmt"
	"html/template"
	"net/http"
	"sort"

	"fiatjaf.com/nostr/nip11"

	"github.com/crocs-muni/scrutiny-fabric-tools/relay/internal/config"
)

// landingTemplate is the hand-written, deliberately unstyled page served at
// GET /. Its prose and the vocabulary row are fixed text — the page is meant
// to read as authored, not generated. The NIP list and version are interpolated
// from the same live document NIP-11 serves, so they cannot disagree with it.
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
<dt>contact</dt><dd>alsorehi@mail.muni.cz</dd>
<dt>policy</dt><dd>reads are open; publishing requires NIP-42 auth as an invited key</dd>
<dt>vocabulary</dt><dd>scrutiny-fabric, scrutiny-product, scrutiny-metadata, scrutiny-binding, scrutiny-patch</dd>
<dt>NIPs</dt><dd>{{range $i, $n := .NIPs}}{{if $i}}, {{end}}<a href="{{$n.HREF}}">{{$n.Number}}</a>{{end}}</dd>
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

// nipRow is one supported-NIP link rendered by the template's {{range}}.
type nipRow struct {
	Number string
	HREF   string
}

// NewLandingHandler builds the exact-match GET / handler served behind
// khatru's router. infoDoc returns the live NIP-11 document so the NIP list
// cannot disagree with what clients see at Accept: application/nostr+json.
func NewLandingHandler(cfg config.Config, infoDoc func(*http.Request) nip11.RelayInformationDocument) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Collect, sort, and link the live NIP list once per request:
		// OverwriteRelayInformation rebuilds info.SupportedNIPs per request.
		doc := infoDoc(r)
		numbers := make([]string, 0, len(doc.SupportedNIPs))
		for _, v := range doc.SupportedNIPs {
			numbers = append(numbers, fmt.Sprint(v))
		}
		sort.Strings(numbers)
		rows := make([]nipRow, 0, len(numbers))
		for _, n := range numbers {
			rows = append(rows, nipRow{Number: n, HREF: nipLinkBase + fmt.Sprintf("%02s", n) + ".md"})
		}

		var body bytes.Buffer
		err := landingTemplate.Execute(&body, struct {
			ServiceURL string
			NIPs       []nipRow
			Version    string
		}{
			ServiceURL: cfg.ServiceURL,
			NIPs:       rows,
			Version:    Version,
		})
		if err != nil {
			http.Error(w, "template error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(body.Bytes())
	})
}
