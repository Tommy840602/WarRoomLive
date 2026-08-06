package com.warroomlive.signaling;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * Single-node backplane: the cluster is this process, so the directory delegates
 * to {@link RoomManager} and cross-node publishing is a no-op (the handler has
 * already delivered to every relevant local session).
 */
@Component
@Profile("!redis")
public class LocalBackplane implements Backplane {

    private final RoomManager rooms;

    public LocalBackplane(RoomManager rooms) {
        this.rooms = rooms;
    }

    @Override
    public void start(LocalDelivery delivery) {
        // No remote messages will ever arrive.
    }

    @Override
    public List<PeerInfo> peersIn(String room) {
        return rooms.peersIn(room);
    }

    @Override
    public void register(String room, String peerId, String name) {
        // Membership already lives in RoomManager via the handler's local join.
    }

    @Override
    public void unregister(String room, String peerId) {
        // Removed together with the local session.
    }

    @Override
    public Optional<String> nodeOf(String room, String peerId) {
        return rooms.session(room, peerId).map(s -> "self");
    }

    @Override
    public void publishToPeer(String room, String toPeerId, SignalMessage message) {
        // Unreachable: a known peer is always local on a single node.
    }

    @Override
    public void publishToRoom(String room, String excludePeerId, SignalMessage message) {
        // No other nodes to inform.
    }

    @Override
    public int roomCount() {
        return rooms.roomCount();
    }

    @Override
    public int memberCount() {
        return rooms.memberCount();
    }
}
