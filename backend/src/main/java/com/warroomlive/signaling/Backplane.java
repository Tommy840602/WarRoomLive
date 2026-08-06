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

    /**
     * Atomically registers a peer (hosted on this node) in the cluster directory,
     * unless the room already holds {@code maxRoomSize} members. Re-registering an
     * existing member (reconnect) always succeeds. The capacity decision lives
     * here so it is race-free per implementation (per-room compute locally, a Lua
     * script on Redis).
     *
     * @return {@code true} if the peer is now a member, {@code false} if the room is full
     */
    boolean tryRegister(String room, String peerId, String name, int maxRoomSize);

    /** Removes a peer from the cluster directory. */
    void unregister(String room, String peerId);

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
