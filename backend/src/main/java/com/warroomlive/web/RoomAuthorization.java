package com.warroomlive.web;

import com.warroomlive.signaling.Backplane;
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

    /**
     * Refuses the caller when the room has a host with a known identity and the
     * caller is not that person.
     *
     * <p>Deliberately silent when the host's subject is unknown: that means
     * either an empty room or a deployment with no identity provider, and in
     * neither case is there anything to compare against. Inventing a refusal
     * there would break the zero-dependency default without protecting anyone.
     *
     * <p>Call this <em>before</em> looking the target up. A 404 from the lookup
     * would tell a caller who may not act whether the thing exists at all.
     */
    public void requireHostIfKnown(String room, String action) {
        Backplane.RoomState state = backplane.roomState(room);
        if (state.hostId() == null) {
            return;
        }
        Optional<String> hostSubject = backplane.subjectOf(room, state.hostId());
        if (hostSubject.isPresent() && !hostSubject.get().equals(caller())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "only the room's host may " + action);
        }
    }
}
