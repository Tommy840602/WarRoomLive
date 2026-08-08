package com.warroomlive.signaling;

import java.util.List;
import java.util.Optional;

/**
 * Cluster view of room membership plus cross-node message routing.
 *
 * <p>{@link SignalingHandler} always tracks the WebSocket sessions connected to
 * <em>this</em> node in {@link RoomManager}; the backplane answers the questions a
 * single node cannot: who is in the room cluster-wide, on which node does a peer
 * live, and how does a message reach sessions held by other nodes.
 *
 * <p>Two implementations: {@link LocalBackplane} (default — one node, everything
 * is local, publishing is a no-op) and {@link RedisBackplane} ({@code redis}
 * profile — membership in Redis hashes, routing over Redis pub/sub).
 */
public interface Backplane {

    /** Delivery sink back into the owning node's local sessions. */
    interface LocalDelivery {
        void toPeer(String room, String peerId, SignalMessage message);

        void toRoomExcept(String room, String excludePeerId, SignalMessage message);
    }

    /** Wires the delivery sink; called once by the handler before any traffic. */
    void start(LocalDelivery delivery);

    /** Peers currently in the room cluster-wide (stale entries pruned best-effort). */
    List<PeerInfo> peersIn(String room);

    /** Returned by {@link #tryRegister} when the room is at capacity. */
    int REGISTER_REJECTED = -1;

    /** Returned by {@link #tryRegister} when the room is locked to newcomers. */
    int REGISTER_LOCKED = -2;

    /**
     * A room's cluster-wide meta state: the current host (the peer that opened the
     * room, handed over to a remaining member when the host leaves), whether the
     * room is locked to newcomers, and whether it has outgrown the mesh. Lives and
     * dies with the room — the state of an empty room is {@link #EMPTY}.
     *
     * @param sfu the room has passed the mesh limit and its media now goes through
     *            the SFU. A latch: once set it stays set for the life of the room
     *            (see {@link #markSfu}).
     */
    record RoomState(String hostId, boolean locked, boolean sfu) {
        public static final RoomState EMPTY = new RoomState(null, false, false);
    }

    /** The room's current meta state ({@link RoomState#EMPTY} if the room is empty). */
    RoomState roomState(String room);

    /**
     * Sets the room's locked flag. Authorization (host-only) is the caller's
     * responsibility — the backplane only stores cluster-wide state.
     */
    void setLocked(String room, boolean locked);

    /**
     * Latches the room onto the SFU, for good.
     *
     * <p>Deliberately one-way. A room that drops from nine people back to eight
     * <em>could</em> return to the mesh, and must not: switching transport costs
     * every participant a renegotiation, so a room hovering around the limit
     * would spend the meeting tearing its media down and building it again. The
     * upgrade is paid once; the latch clears when the room empties, along with
     * the rest of its state.
     *
     * <p>Being monotonic is also why this needs no atomicity of its own, unlike
     * the capacity decision: concurrent callers can only ever set it to the same
     * value.
     */
    void markSfu(String room);

    /**
     * Atomically registers a peer (hosted on this node) in the cluster directory,
     * unless the room already holds {@code maxRoomSize} members or is locked.
     * Re-registering an existing member (reconnect) always succeeds. The
     * capacity/lock decision lives here so it is race-free per implementation
     * (per-room compute locally, a Lua script on Redis). The same atomic step
     * assigns the host: the peer that opens the room, or a replacement whenever
     * the recorded host is no longer a member.
     *
     * @param subject the authenticated identity behind the peer, or null when the
     *                deployment has no identity provider. Kept out of
     *                {@link PeerInfo} on purpose — the room needs to see names,
     *                not everyone else's account identifiers.
     * @return the room's member count after registering (1 ⇒ this join opened the
     *         room), {@link #REGISTER_REJECTED} if the room is full, or
     *         {@link #REGISTER_LOCKED} if it is locked
     */
    int tryRegister(String room, String peerId, String name, String subject, int maxRoomSize);

    /**
     * The authenticated identity behind a peer, if there is one.
     *
     * <p>This is what lets a decision be made about <em>who</em> a peer is from
     * outside the connection that carries it — an HTTP request, say, which knows
     * a subject but no peer id.
     */
    Optional<String> subjectOf(String room, String peerId);

    /**
     * Removes a peer from the cluster directory. If the departing peer was the
     * host, the host role is handed to a remaining member in the same atomic
     * step (the longest-present member locally; an arbitrary member on Redis).
     *
     * @return the members remaining in the room (0 ⇒ this leave closed the room)
     */
    int unregister(String room, String peerId);

    /** The node hosting the peer, if known ({@code self} on the local impl). */
    Optional<String> nodeOf(String room, String peerId);

    /** Fans a point-to-point message out to the node hosting the target peer. */
    void publishToPeer(String room, String toPeerId, SignalMessage message);

    /**
     * Fans a room broadcast out to <em>other</em> nodes. The caller has already
     * delivered to its own local sessions; implementations must not echo back.
     */
    void publishToRoom(String room, String excludePeerId, SignalMessage message);

    int roomCount();

    int memberCount();
}
