package com.warroomlive.signaling;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Single-node backplane. Owns the membership directory (mirroring what
 * {@link RoomManager} tracks alongside the live sessions) so that the
 * capacity/lock decision in {@link #tryRegister} is atomic: every access to a
 * room's record — reads included — runs inside {@code ConcurrentHashMap.compute},
 * which serializes concurrent operations on the same room. Members keep
 * insertion order, so the host is simply the longest-present member: opening
 * the room makes you host, and host handover on leave is automatic. Cross-node
 * publishing is a no-op — there are no other nodes.
 */
@Component
@Profile("!redis")
public class LocalBackplane implements Backplane {

    /** What the directory knows about a member beyond its id. */
    private record MemberInfo(String name, String subject) {
    }

    /** Mutated only inside {@code directory.compute} — insertion order is the host order. */
    private static final class RoomRecord {
        final LinkedHashMap<String, MemberInfo> members = new LinkedHashMap<>();
        boolean locked;
        /** One-way: set when the room outgrows the mesh, cleared only by the room ending. */
        boolean sfu;

        String host() {
            return members.isEmpty() ? null : members.keySet().iterator().next();
        }
    }

    /** room -> record */
    private final Map<String, RoomRecord> directory = new ConcurrentHashMap<>();

    @Override
    public void start(LocalDelivery delivery) {
        // No remote messages will ever arrive.
    }

    @Override
    public List<PeerInfo> peersIn(String room) {
        List<PeerInfo> peers = new ArrayList<>();
        directory.computeIfPresent(room, (r, record) -> {
            record.members.forEach((id, member) -> peers.add(new PeerInfo(id, member.name())));
            return record;
        });
        return List.copyOf(peers);
    }

    @Override
    public RoomState roomState(String room) {
        AtomicReference<RoomState> state = new AtomicReference<>(RoomState.EMPTY);
        directory.computeIfPresent(room, (r, record) -> {
            state.set(new RoomState(record.host(), record.locked, record.sfu));
            return record;
        });
        return state.get();
    }

    @Override
    public void setLocked(String room, boolean locked) {
        directory.computeIfPresent(room, (r, record) -> {
            record.locked = locked;
            return record;
        });
    }

    @Override
    public void markSfu(String room) {
        directory.computeIfPresent(room, (r, record) -> {
            record.sfu = true;
            return record;
        });
    }

    @Override
    public int tryRegister(String room, String peerId, String name, String subject, int maxRoomSize) {
        AtomicInteger sizeAfter = new AtomicInteger(REGISTER_REJECTED);
        directory.compute(room, (r, record) -> {
            RoomRecord next = record != null ? record : new RoomRecord();
            if (!next.members.containsKey(peerId)) {
                if (next.locked) {
                    sizeAfter.set(REGISTER_LOCKED);
                    return record; // rejected; leave untouched (null stays null)
                }
                if (next.members.size() >= maxRoomSize) {
                    return record;
                }
            }
            next.members.put(peerId, new MemberInfo(name, subject));
            sizeAfter.set(next.members.size());
            return next;
        });
        return sizeAfter.get();
    }

    @Override
    public int unregister(String room, String peerId) {
        AtomicInteger remaining = new AtomicInteger(0);
        directory.computeIfPresent(room, (r, record) -> {
            record.members.remove(peerId);
            remaining.set(record.members.size());
            return record.members.isEmpty() ? null : record;
        });
        return remaining.get();
    }

    @Override
    public Optional<String> subjectOf(String room, String peerId) {
        AtomicReference<String> subject = new AtomicReference<>();
        directory.computeIfPresent(room, (r, record) -> {
            MemberInfo member = record.members.get(peerId);
            if (member != null) {
                subject.set(member.subject());
            }
            return record;
        });
        return Optional.ofNullable(subject.get());
    }

    @Override
    public Optional<String> nodeOf(String room, String peerId) {
        AtomicReference<String> node = new AtomicReference<>();
        directory.computeIfPresent(room, (r, record) -> {
            if (record.members.containsKey(peerId)) {
                node.set("self");
            }
            return record;
        });
        return Optional.ofNullable(node.get());
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
        return directory.values().stream().mapToInt(record -> record.members.size()).sum();
    }
}
