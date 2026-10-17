// Package gate implements the write-side admission gates of the relay.
//
// A Gate is exactly the shape khatru expects for relay.OnEvent:
// (reject bool, msg string). The message must keep its NIP-01 prefix
// ("auth-required: ", "blocked: ") because khatru inspects it: an
// "auth-required:" prefix makes the relay send a NIP-42 challenge back to the
// client automatically (khatru/handlers.go:269-271), while "blocked: " is
// passed through to the client unchanged.
//
// Gates only run on writes. Reads are never gated in this relay.
package gate

import (
	"context"
	"fmt"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
)

// Gate decides whether an incoming event must be rejected before it is stored.
type Gate interface {
	Check(ctx context.Context, event nostr.Event) (reject bool, msg string)
}

// Func adapts a plain function with the khatru hook shape (for example the
// constructors of fiatjaf.com/nostr/khatru/policies) to the Gate interface.
type Func func(ctx context.Context, event nostr.Event) (reject bool, msg string)

// Check implements Gate.
func (f Func) Check(ctx context.Context, event nostr.Event) (reject bool, msg string) {
	return f(ctx, event)
}

// Seq composes gates into one, in order: the first gate that rejects wins.
func Seq(gates ...Gate) Gate {
	return Func(func(ctx context.Context, event nostr.Event) (reject bool, msg string) {
		for _, g := range gates {
			if reject, msg := g.Check(ctx, event); reject {
				return true, msg
			}
		}
		return false, ""
	})
}

// Rejection messages. Exported so tests and docs can assert on them.
const (
	// MsgAuthRequired must keep the "auth-required: " prefix: khatru reacts to
	// it by sending a NIP-42 AUTH challenge before the OK:false.
	MsgAuthRequired = "auth-required: writes require authentication"
	// MsgNotAllowed is for an authenticated pubkey outside the pilot allowlist.
	MsgNotAllowed = "blocked: not an allowed publisher"
	// MsgKindRejected is formatted with the offending kind.
	MsgKindRejected = "blocked: kind %d is not accepted by this relay"
	// MsgNoVocabulary is for kind 1 events without an accepted t tag.
	MsgNoVocabulary = "blocked: kind 1 event carries no accepted scrutiny t tag"
)

// AuthGate requires every write to come from a NIP-42-authenticated pubkey
// that is on the pilot allowlist.
//
// Reads are NOT gated: this gate is only wired into relay.OnEvent.
type AuthGate struct {
	allowed map[nostr.PubKey]struct{}
}

// NewAuthGate builds the allowlist gate. The list must not be empty (the
// config package enforces that for environment-loaded configurations).
func NewAuthGate(allowedPubkeys []nostr.PubKey) *AuthGate {
	allowed := make(map[nostr.PubKey]struct{}, len(allowedPubkeys))
	for _, pk := range allowedPubkeys {
		allowed[pk] = struct{}{}
	}
	return &AuthGate{allowed: allowed}
}

// Check implements Gate.
func (g *AuthGate) Check(ctx context.Context, evt nostr.Event) (reject bool, msg string) {
	authed, ok := khatru.GetAuthed(ctx)
	if !ok {
		// The "auth-required: " prefix makes khatru answer with a fresh NIP-42
		// challenge before the OK:false, so the client can authenticate and
		// retry without any extra round trip.
		return true, MsgAuthRequired
	}
	if _, allowed := g.allowed[authed]; !allowed {
		// Deliberately "blocked:", not "restricted:": several clients do not
		// recognize "restricted:" (see NIP-42 status quo).
		return true, MsgNotAllowed
	}
	// The authenticated identity must be the event's author, not just an
	// allowlisted key: NIP-42 authenticates a connection, so with a multi-key
	// allowlist one authenticated key could otherwise import events signed by
	// any key at all.
	if evt.PubKey != authed {
		return true, "blocked: event author must be the authenticated pubkey"
	}
	return false, ""
}

// VocabularyGate implements the pilot vocabulary gate:
//
//   - kind 5 (deletion request, NIP-09) is always accepted: DEL-11 requires
//     these events to be stored and served while never being acted upon, so
//     they must pass the gate and reach the store;
//   - kind 1 (text note) is accepted iff at least one of its t tag values is in
//     the accepted set (exact, case-sensitive match);
//   - every other kind is rejected.
//
// This is the seam for later spec validation: replace or extend this gate when
// the scrutiny-fabric spec grows a real event schema.
type VocabularyGate struct {
	accepted map[string]struct{}
}

// NewVocabularyGate builds the vocabulary gate from the accepted t tag values.
func NewVocabularyGate(acceptedTags []string) *VocabularyGate {
	accepted := make(map[string]struct{}, len(acceptedTags))
	for _, tag := range acceptedTags {
		accepted[tag] = struct{}{}
	}
	return &VocabularyGate{accepted: accepted}
}

// Check implements Gate.
func (g *VocabularyGate) Check(_ context.Context, event nostr.Event) (reject bool, msg string) {
	switch event.Kind {
	case nostr.KindDeletion:
		// DEL-11: the deletion request is accepted and stored, never acted on.
		return false, ""
	case nostr.KindTextNote:
		if g.carriesAcceptedTag(event) {
			return false, ""
		}
		return true, MsgNoVocabulary
	default:
		return true, fmt.Sprintf(MsgKindRejected, event.Kind)
	}
}

func (g *VocabularyGate) carriesAcceptedTag(event nostr.Event) bool {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "t" {
			if _, ok := g.accepted[tag[1]]; ok {
				return true
			}
		}
	}
	return false
}
