package com.warroomlive.signaling;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Single-node backplane. Owns the membership directory (mirroring what
 * {@link RoomManager} tracks alongside the live sessions) so that the capacity
 * decision in {@link #tryRegister} is atomic: the per-room map is swapped via
 * {@code ConcurrentHashMap.compute}, which serializes concurrent joins to the
 * same room. Cross-node publishing is a no-op — there are no other nodes.
 */
@Component
@Profile("!redis")
public class LocalBackplane implements Backplane {

    /** room -> (peer id -> display name) */
    private final Map<String, Map<String, String>> directory = new ConcurrentHashMap<>();

    @Override
    public void start(LocalDelivery delivery) {
        // No remote messages will ever arrive.
    }

    @Override
    public List<PeerInfo> peersIn(String room) {
        Map<String, String> members = directory.get(room);
        return members == null
                ? List.of()
                : members.entrySet().stream().map(e -> new PeerInfo(e.getKey(), e.getValue())).toList();
    }

    @Override
    public boolean tryRegister(String room, String peerId, String name, int maxRoomSize) {
        AtomicBoolean accepted = new AtomicBoolean(false);
        directory.compute(room, (r, members) -> {
            Map<String, String> next = members != null ? members : new ConcurrentHashMap<>();
            if (next.size() >= maxRoomSize && !next.containsKey(peerId)) {
                return members; // full; leave untouched (null stays null)
            }
            next.put(peerId, name);
            accepted.set(true);
            return next;
        });
        return accepted.get();
    }

    @Override
    public void unregister(String room, String peerId) {
        directory.computeIfPresent(room, (r, members) -> {
            members.remove(peerId);
            return members.isEmpty() ? null : members;
        });
    }

    @Override
    public Optional<String> nodeOf(String room, String peerId) {
        Map<String, String> members = directory.get(room);
        return members != null && members.containsKey(peerId) ? Optional.of("self") : Optional.empty();
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
        return directory.size();
    }

    @Override
    public int memberCount() {
        return directory.values().stream().mapToInt(Map::size).sum();
    }
}
