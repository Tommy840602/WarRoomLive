package com.warroomlive.web;

import com.warroomlive.signaling.Backplane;
import com.warroomlive.signaling.PeerInfo;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

/**
 * Who is calling, and may they act on this room.
 *
 * <p>Extracted once the third endpoint needed the same two answers. Both are
 * subtle enough that having one copy matters more than the few lines saved.
 */
@Component
public class RoomAuthorization {

    private final Backplane backplane;

    public RoomAuthorization(Backplane backplane) {
        this.backplane = backplane;
    }

    /**
     * The authenticated subject, or {@code anonymous} when the app runs without
     * auth. Spring's own anonymous principal is called {@code anonymousUser},
     * which would end up in audit events and on screen; one name for "nobody" is
     * enough.
     */
    public String caller() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String name = auth == null ? null : auth.getName();
        return name == null || name.equals("anonymousUser") ? "anonymous" : name;
    }

    /** Whether this request carries a real authenticated identity. */
    public boolean authenticated() {
        return !caller().equals("anonymous");
    }

    /**
     * Requires an exact signaling peer to be present in the room and, when OIDC
     * is active, owned by the HTTP caller. This binds HTTP-issued capabilities
     * (notably LiveKit tokens) to the WebSocket identity the server accepted.
     */
    public PeerInfo requirePeer(String room, String peerId, String action) {
        PeerInfo peer = backplane.peersIn(room).stream()
                .filter(candidate -> candidate.id().equals(peerId))
                .findFirst()
                .orElseThrow(() -> forbidden("join the room before attempting to " + action));
        if (authenticated()) {
            String subject = backplane.subjectOf(room, peerId)
                    .orElseThrow(() -> forbidden("use an authenticated room membership to " + action));
            if (!subject.equals(caller())) {
                throw forbidden("act only as your own room peer");
            }
        }
        return peer;
    }

    /**
     * Requires the authenticated caller to be one of the room's live members.
     * The anonymous, zero-dependency development mode remains intentionally open.
     */
    public void requireRoomMember(String room, String action) {
        if (!authenticated()) {
            return;
        }
        String subject = caller();
        boolean member = backplane.peersIn(room).stream()
                .anyMatch(peer -> backplane.subjectOf(room, peer.id())
                        .filter(subject::equals)
                        .isPresent());
        if (!member) {
            throw forbidden("join the room before attempting to " + action);
        }
    }

    /**
     * Requires the authenticated caller to be the room's live host. OIDC mode
     * fails closed when the room is empty or the host has no bound subject;
     * anonymous development mode keeps the zero-dependency behaviour.
     *
     * <p>Call this <em>before</em> looking the target up. A 404 from the lookup
     * would tell a caller who may not act whether the thing exists at all.
     */
    public void requireHostIfKnown(String room, String action) {
        Backplane.RoomState state = backplane.roomState(room);
        if (state.hostId() == null) {
            if (authenticated()) {
                throw forbidden("act on an active room as its host");
            }
            return;
        }
        Optional<String> hostSubject = backplane.subjectOf(room, state.hostId());
        if (authenticated() && hostSubject.isEmpty()) {
            throw forbidden("use an authenticated host membership to " + action);
        }
        if (hostSubject.isPresent() && !hostSubject.get().equals(caller())) {
            throw forbidden("act as the room's host");
        }
    }

    /** Recording may only start while a room has a host, even in dev mode. */
    public void requireActiveHost(String room, String action) {
        if (backplane.roomState(room).hostId() == null) {
            throw forbidden("start from an active room");
        }
        requireHostIfKnown(room, action);
    }

    private static ResponseStatusException forbidden(String detail) {
        return new ResponseStatusException(HttpStatus.FORBIDDEN, detail);
    }
}
