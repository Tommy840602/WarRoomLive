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

    /** A connected participant: its public identity plus the live transport. */
    private record Member(PeerInfo info, WebSocketSession session) {
    }

    /** room id -> (peer id -> member) */
    private final Map<String, Map<String, Member>> rooms = new ConcurrentHashMap<>();

    /** websocket session id -> where that session is registered, for O(1) cleanup on disconnect */
    private final Map<String, PeerLocation> sessionIndex = new ConcurrentHashMap<>();

    /** Identifies a peer's placement within a room. */
    public record PeerLocation(String room, String peerId) {
    }

    /**
     * Registers a peer in a room.
     *
     * @return the peers that were already present (excluding the joining peer)
     */
    public List<PeerInfo> join(String room, String peerId, String name, WebSocketSession session) {
        Map<String, Member> members = rooms.computeIfAbsent(room, r -> new ConcurrentHashMap<>());
        List<PeerInfo> existing = members.values().stream()
                .map(Member::info)
                .filter(info -> !info.id().equals(peerId))
                .toList();
        members.put(peerId, new Member(new PeerInfo(peerId, name), session));
        sessionIndex.put(session.getId(), new PeerLocation(room, peerId));
        return existing;
    }

    /**
     * Removes the peer associated with the given session, if any.
     *
     * <p>A close arriving for a session the peer has already replaced is ignored.
     * That is the reconnect case: a client whose socket died re-joins on a new
     * session, and only later — a TCP timeout after a laptop sleep, say — does
     * the old socket's close arrive. Removing the peer then would evict the
     * live connection and tell the room it left, while the client believes it
     * is back in.
     *
     * @return the location it occupied, or empty when the session was stale, so
     *         callers only notify the room about a departure that really happened
     */
    public Optional<PeerLocation> remove(WebSocketSession session) {
        PeerLocation location = sessionIndex.remove(session.getId());
        if (location == null) {
            return Optional.empty();
        }
        Map<String, Member> members = rooms.get(location.room());
        if (members == null) {
            return Optional.of(location);
        }
        Member current = members.get(location.peerId());
        if (current != null && !current.session().getId().equals(session.getId())) {
            return Optional.empty(); // superseded by a reconnect; nothing to do
        }
        members.remove(location.peerId());
        if (members.isEmpty()) {
            // Guard against leaking empty rooms; only drop if still empty.
            rooms.compute(location.room(), (r, m) -> (m != null && m.isEmpty()) ? null : m);
        }
        return Optional.of(location);
    }

    /**
     * The room/peer this session joined as, if any. Privileged operations use
     * this to bind a message's claimed {@code from} to the sending connection —
     * a client cannot act as a peer it did not join as.
     */
    public Optional<PeerLocation> locationOf(WebSocketSession session) {
        return Optional.ofNullable(sessionIndex.get(session.getId()));
    }

    /** Returns the peers currently in the room (empty if the room is unknown). */
    public List<PeerInfo> peersIn(String room) {
        Map<String, Member> members = rooms.get(room);
        return members == null ? List.of() : members.values().stream().map(Member::info).toList();
    }

    /** Looks up a peer's display name within a room. */
    public Optional<String> nameOf(String room, String peerId) {
        Map<String, Member> members = rooms.get(room);
        Member member = members == null ? null : members.get(peerId);
        return Optional.ofNullable(member == null ? null : member.info().name());
    }

    /** Looks up the live session for a peer within a room. */
    public Optional<WebSocketSession> session(String room, String peerId) {
        Map<String, Member> members = rooms.get(room);
        Member member = members == null ? null : members.get(peerId);
        return Optional.ofNullable(member == null ? null : member.session());
    }

    /** Number of rooms with at least one connected peer. */
    public int roomCount() {
        return rooms.size();
    }

    /** Number of connected peers across all rooms. */
    public int memberCount() {
        return sessionIndex.size();
    }

    /**
     * Returns every session in a room except the excluded peer — used for
     * broadcasts. A null exclusion means everyone, which is what a
     * server-originated event wants: nobody sent it, so nobody is skipped.
     */
    public List<WebSocketSession> othersIn(String room, String excludePeerId) {
        Map<String, Member> members = rooms.get(room);
        if (members == null) {
            return List.of();
        }
        return members.entrySet().stream()
                .filter(e -> !e.getKey().equals(excludePeerId))
                .map(e -> e.getValue().session())
                .toList();
    }
}
