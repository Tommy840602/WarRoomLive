package com.warroomlive.signaling;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The directory answers who is in a room and, now, who they actually are.
 * The identity is what an authorization decision made outside the connection
 * has to rest on, so it must survive the same operations membership does.
 */
class LocalBackplaneTest {

    private static final int CAP = 8;

    @Test
    void remembersTheIdentityBehindAPeer() {
        LocalBackplane backplane = new LocalBackplane();
        backplane.tryRegister("r", "peer-1", "Alice", "alice@example.com", CAP);

        assertThat(backplane.subjectOf("r", "peer-1")).contains("alice@example.com");
    }

    @Test
    void hasNoIdentityWithoutAnIdentityProvider() {
        // The zero-dependency default: nobody is anybody, and that must read as
        // "unknown" rather than as some placeholder a check could match against.
        LocalBackplane backplane = new LocalBackplane();
        backplane.tryRegister("r", "peer-1", "Alice", null, CAP);

        assertThat(backplane.subjectOf("r", "peer-1")).isEmpty();
    }

    @Test
    void forgetsTheIdentityWhenThePeerLeaves() {
        LocalBackplane backplane = new LocalBackplane();
        backplane.tryRegister("r", "peer-1", "Alice", "alice", CAP);
        backplane.tryRegister("r", "peer-2", "Bob", "bob", CAP);
        backplane.unregister("r", "peer-1");

        assertThat(backplane.subjectOf("r", "peer-1")).isEmpty();
        assertThat(backplane.subjectOf("r", "peer-2")).contains("bob");
    }

    @Test
    void aReconnectRefreshesTheIdentityRatherThanKeepingTheOldOne() {
        // Re-registering is the reconnect path. A stale subject would let a
        // logged-out session keep the authority its token used to carry.
        LocalBackplane backplane = new LocalBackplane();
        backplane.tryRegister("r", "peer-1", "Alice", "alice", CAP);
        backplane.tryRegister("r", "peer-1", "Alice", "alice-renewed", CAP);

        assertThat(backplane.subjectOf("r", "peer-1")).contains("alice-renewed");
    }

    @Test
    void theHostIsTheLongestPresentMemberAndHasAnIdentity() {
        LocalBackplane backplane = new LocalBackplane();
        backplane.tryRegister("r", "peer-1", "Alice", "alice", CAP);
        backplane.tryRegister("r", "peer-2", "Bob", "bob", CAP);

        String host = backplane.roomState("r").hostId();
        assertThat(host).isEqualTo("peer-1");
        assertThat(backplane.subjectOf("r", host)).contains("alice");

        // Handover carries the identity with the role, or an authorization check
        // against the new host would silently fall open.
        backplane.unregister("r", "peer-1");
        String next = backplane.roomState("r").hostId();
        assertThat(next).isEqualTo("peer-2");
        assertThat(backplane.subjectOf("r", next)).contains("bob");
    }

    @Test
    void anUnknownPeerHasNoIdentity() {
        LocalBackplane backplane = new LocalBackplane();
        assertThat(backplane.subjectOf("nobody-here", "peer-1")).isEmpty();
    }
}
