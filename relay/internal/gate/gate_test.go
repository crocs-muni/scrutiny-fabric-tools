package gate

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
)

func testEvent(kind nostr.Kind, tags nostr.Tags) nostr.Event {
	return testEventFrom(kind, tags, nostr.PubKey{})
}

func testEventFrom(kind nostr.Kind, tags nostr.Tags, author nostr.PubKey) nostr.Event {
	return nostr.Event{
		Kind:      kind,
		Tags:      tags,
		Content:   "gate test content",
		CreatedAt: nostr.Now(),
		PubKey:    author,
	}
}

func TestVocabularyGateMatrix(t *testing.T) {
	g := NewVocabularyGate([]string{"scrutiny-fabric", "scrutiny-product-test"})

	tests := []struct {
		name   string
		event  nostr.Event
		reject bool
	}{
		{
			name:   "kind 5 without any tag is accepted",
			event:  testEvent(nostr.KindDeletion, nil),
			reject: false,
		},
		{
			name:   "kind 5 with an e tag is accepted",
			event:  testEvent(nostr.KindDeletion, nostr.Tags{{"e", strings.Repeat("ab", 32)}}),
			reject: false,
		},
		{
			name:   "kind 1 with an accepted t tag is accepted",
			event:  testEvent(nostr.KindTextNote, nostr.Tags{{"t", "scrutiny-product-test"}}),
			reject: false,
		},
		{
			name:   "kind 1 with the accepted tag after others is accepted",
			event:  testEvent(nostr.KindTextNote, nostr.Tags{{"t", "unrelated"}, {"t", "scrutiny-fabric"}}),
			reject: false,
		},
		{
			name:   "kind 1 without any t tag is rejected",
			event:  testEvent(nostr.KindTextNote, nostr.Tags{{"p", strings.Repeat("cd", 32)}}),
			reject: true,
		},
		{
			name:   "kind 1 with an unaccepted t tag is rejected",
			event:  testEvent(nostr.KindTextNote, nostr.Tags{{"t", "scrutiny-v0.8.1"}}),
			reject: true,
		},
		{
			name:   "kind 1 with a truncated t tag is rejected",
			event:  testEvent(nostr.KindTextNote, nostr.Tags{{"t"}}),
			reject: true,
		},
		{
			name:   "kind 0 is rejected",
			event:  testEvent(nostr.KindProfileMetadata, nil),
			reject: true,
		},
		{
			name:   "kind 7 is rejected",
			event:  testEvent(nostr.KindReaction, nostr.Tags{{"t", "scrutiny-fabric"}}),
			reject: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reject, msg := g.Check(context.Background(), tc.event)
			if reject != tc.reject {
				t.Fatalf("Check() reject = %v (%q), want %v", reject, msg, tc.reject)
			}
			if reject && msg == "" {
				t.Fatal("rejections must carry a reason")
			}
			if !reject && msg != "" {
				t.Fatalf("acceptance must not carry a reason, got %q", msg)
			}
		})
	}
}

func TestVocabularyGateMessages(t *testing.T) {
	g := NewVocabularyGate([]string{"scrutiny-fabric"})

	reject, msg := g.Check(context.Background(), testEvent(nostr.KindTextNote, nil))
	if !reject || msg != MsgNoVocabulary {
		t.Fatalf("kind 1 without a tag: reject = %v, msg = %q, want %q", reject, msg, MsgNoVocabulary)
	}
	if !strings.HasPrefix(msg, "blocked: ") {
		t.Errorf("rejection message %q must keep the blocked: prefix", msg)
	}

	_, msg = g.Check(context.Background(), testEvent(nostr.KindReaction, nil))
	if want := fmt.Sprintf(MsgKindRejected, nostr.KindReaction); msg != want {
		t.Fatalf("kind 7: msg = %q, want %q", msg, want)
	}
}

func TestAuthGate(t *testing.T) {
	allowedPK := nostr.Generate().Public()
	otherPK := nostr.Generate().Public()
	g := NewAuthGate([]nostr.PubKey{allowedPK})

	t.Run("unauthenticated writes are rejected as auth-required", func(t *testing.T) {
		reject, msg := g.Check(context.Background(), testEvent(nostr.KindTextNote, nil))
		if !reject {
			t.Fatal("expected a rejection")
		}
		if msg != MsgAuthRequired {
			t.Fatalf("msg = %q, want %q", msg, MsgAuthRequired)
		}
		if !strings.HasPrefix(msg, "auth-required:") {
			t.Fatalf("msg %q must keep the auth-required: prefix so khatru sends the challenge", msg)
		}
	})

	t.Run("authenticated but not allowlisted publishers are blocked", func(t *testing.T) {
		ctx := khatru.ForceSetAuthed(context.Background(), otherPK)
		reject, msg := g.Check(ctx, testEvent(nostr.KindTextNote, nil))
		if !reject {
			t.Fatal("expected a rejection")
		}
		if msg != MsgNotAllowed {
			t.Fatalf("msg = %q, want %q", msg, MsgNotAllowed)
		}
		if !strings.HasPrefix(msg, "blocked:") {
			t.Fatalf("msg %q must keep a blocked: prefix", msg)
		}
	})

	t.Run("allowlisted publishers pass", func(t *testing.T) {
		ctx := khatru.ForceSetAuthed(context.Background(), allowedPK)
		evt := testEventFrom(nostr.KindTextNote, nil, allowedPK)
		if reject, msg := g.Check(ctx, evt); reject {
			t.Fatalf("expected acceptance, got %q", msg)
		}
	})

	t.Run("author must be the authenticated pubkey", func(t *testing.T) {
		ctx := khatru.ForceSetAuthed(context.Background(), allowedPK)
		evt := testEventFrom(nostr.KindTextNote, nil, otherPK)
		reject, msg := g.Check(ctx, evt)
		if !reject {
			t.Fatal("expected a rejection when the author is not the authed key")
		}
		if !strings.HasPrefix(msg, "blocked:") {
			t.Fatalf("msg %q must keep a blocked: prefix", msg)
		}
	})
}

func TestSeqFirstRejectWins(t *testing.T) {
	allowedPK := nostr.Generate().Public()
	seq := Seq(
		NewAuthGate([]nostr.PubKey{allowedPK}),
		NewVocabularyGate([]string{"scrutiny-fabric"}),
	)

	// unauthenticated: the auth gate speaks first, even though the event would
	// also fail the vocabulary gate
	reject, msg := seq.Check(context.Background(), testEvent(nostr.KindTextNote, nil))
	if !reject || msg != MsgAuthRequired {
		t.Fatalf("unauth: reject = %v, msg = %q, want %q", reject, msg, MsgAuthRequired)
	}

	// authenticated: the vocabulary gate speaks
	ctx := khatru.ForceSetAuthed(context.Background(), allowedPK)
	reject, msg = seq.Check(ctx, testEventFrom(nostr.KindTextNote, nil, allowedPK))
	if !reject || msg != MsgNoVocabulary {
		t.Fatalf("authed: reject = %v, msg = %q, want %q", reject, msg, MsgNoVocabulary)
	}

	// an accepted event passes the whole chain
	reject, msg = seq.Check(ctx, testEventFrom(nostr.KindTextNote, nostr.Tags{{"t", "scrutiny-fabric"}}, allowedPK))
	if reject {
		t.Fatalf("expected acceptance, got %q", msg)
	}
}
