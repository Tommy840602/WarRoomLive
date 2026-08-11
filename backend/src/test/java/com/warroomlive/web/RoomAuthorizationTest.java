package com.warroomlive.web;

import com.warroomlive.signaling.LocalBackplane;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RoomAuthorizationTest {

    private LocalBackplane backplane;
    private RoomAuthorization authorization;

    @BeforeEach
    void setUp() {
        backplane = new LocalBackplane();
        authorization = new RoomAuthorization(backplane);
    }

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void mediaPeerMustBelongToTheAuthenticatedCaller() {
        backplane.tryRegister("room", "peer-a", "Alice", "alice", 8);
        authenticate("alice");

        assertThat(authorization.requirePeer("room", "peer-a", "request media").name())
                .isEqualTo("Alice");

        authenticate("bob");
        assertForbidden(() -> authorization.requirePeer("room", "peer-a", "request media"));
        assertForbidden(() -> authorization.requirePeer("room", "missing", "request media"));
    }

    @Test
    void authenticatedRoomReadsRequireALiveMembership() {
        backplane.tryRegister("room", "peer-a", "Alice", "alice", 8);

        authenticate("alice");
        authorization.requireRoomMember("room", "read records");

        authenticate("bob");
        assertForbidden(() -> authorization.requireRoomMember("room", "read records"));
    }

    @Test
    void destructiveHostChecksFailClosedWhenTheRoomIsEmpty() {
        authenticate("alice");
        assertForbidden(() -> authorization.requireHostIfKnown("empty", "delete files"));
        assertForbidden(() -> authorization.requireActiveHost("empty", "start recording"));
    }

    @Test
    void destructiveActionsRequireTheAuthenticatedLiveHost() {
        backplane.tryRegister("room", "host", "Alice", "alice", 8);
        backplane.tryRegister("room", "member", "Bob", "bob", 8);

        authenticate("alice");
        authorization.requireHostIfKnown("room", "delete files");

        authenticate("bob");
        assertForbidden(() -> authorization.requireHostIfKnown("room", "delete files"));

        backplane.tryRegister("unbound", "host", "Guest", null, 8);
        authenticate("alice");
        assertForbidden(() -> authorization.requireHostIfKnown("unbound", "delete files"));
    }

    @Test
    void anonymousDevelopmentModeStillUsesTheLivePeerBoundary() {
        backplane.tryRegister("room", "peer-a", "Guest", null, 8);
        assertThat(authorization.requirePeer("room", "peer-a", "request media").name())
                .isEqualTo("Guest");
        authorization.requireRoomMember("room", "read records");
        authorization.requireHostIfKnown("room", "delete files");
    }

    private static void authenticate(String subject) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(subject, "n/a", List.of()));
    }

    private static void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
                .isInstanceOf(ResponseStatusException.class)
                .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
                .isEqualTo(403);
    }
}
