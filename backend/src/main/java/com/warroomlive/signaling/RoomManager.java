package com.warroomlive.signaling;

import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory registry of rooms and the peers connected to each.
 *
 * <p>State lives only in this process; a horizontally scaled deployment would need a
 * shared backplane (e.g. Redis pub/sub). All maps are concurrent so the handler can be
 * driven from multiple WebSocket I/O threads without external locking.
 */
@Component
public class RoomManager {

    /** room id -> (peer id -> session) */
    private final Map<String, Map<String, WebSocketSession>> rooms = new ConcurrentHashMap<>();

    /** websocket session id -> where that session is registered, for O(1) cleanup on disconnect */
    private final Map<String, PeerLocation> sessionIndex = new ConcurrentHashMap<>();

    /** Identifies a peer's placement within a room. */
    public record PeerLocation(String room, String peerId) {
    }

    /**
     * Registers a peer in a room.
     *
     * @return the peer ids that were already present (excluding the joining peer)
     */
    public List<String> join(String room, String peerId, WebSocketSession session) {
        Map<String, WebSocketSession> members = rooms.computeIfAbsent(room, r -> new ConcurrentHashMap<>());
        List<String> existing = members.keySet().stream().filter(id -> !id.equals(peerId)).toList();
        members.put(peerId, session);
        sessionIndex.put(session.getId(), new PeerLocation(room, peerId));
        return existing;
    }

    /**
     * Removes the peer associated with the given session, if any.
     *
     * @return the location it occupied, so callers can notify the remaining peers
     */
    public Optional<PeerLocation> remove(WebSocketSession session) {
        PeerLocation location = sessionIndex.remove(session.getId());
        if (location == null) {
            return Optional.empty();
        }
        Map<String, WebSocketSession> members = rooms.get(location.room());
        if (members != null) {
            members.remove(location.peerId());
            if (members.isEmpty()) {
                // Guard against leaking empty rooms; only drop if still empty.
                rooms.compute(location.room(), (r, m) -> (m != null && m.isEmpty()) ? null : m);
            }
        }
        return Optional.of(location);
    }

    /** Returns the peer ids currently in the room (empty if the room is unknown). */
    public List<String> peersIn(String room) {
        Map<String, WebSocketSession> members = rooms.get(room);
        return members == null ? List.of() : List.copyOf(members.keySet());
    }

    /** Looks up the live session for a peer within a room. */
    public Optional<WebSocketSession> session(String room, String peerId) {
        Map<String, WebSocketSession> members = rooms.get(room);
        return Optional.ofNullable(members == null ? null : members.get(peerId));
    }

    /** Returns every session in a room except the excluded peer — used for broadcasts. */
    public List<WebSocketSession> othersIn(String room, String excludePeerId) {
        Map<String, WebSocketSession> members = rooms.get(room);
        if (members == null) {
            return List.of();
        }
        return members.entrySet().stream()
                .filter(e -> !e.getKey().equals(excludePeerId))
                .map(Map.Entry::getValue)
                .toList();
    }
}
