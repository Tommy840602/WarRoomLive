package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Redis-backed backplane ({@code redis} profile) for horizontally scaled signaling.
 *
 * <p>Data model:
 * <ul>
 *   <li>{@code warroom:room:<room>} — hash: peerId → JSON {name, node}. The room's
 *       cluster-wide membership; the hash disappears with its last field.
 *   <li>{@code warroom:rooms} — set of room names (for the rooms gauge).
 *   <li>{@code warroom:node:<id>} — per-node heartbeat key with a TTL, refreshed on
 *       a schedule. Members whose node heartbeat is gone are ghosts (their node
 *       died without disconnecting them) and are pruned lazily whenever a room's
 *       membership is read.
 *   <li>channel {@code warroom:signal} — pub/sub envelope {origin, room, to?,
 *       exclude?, message}. Point-to-point messages name {@code to}; broadcasts
 *       name {@code exclude}. Nodes ignore their own broadcasts (the origin node
 *       already delivered locally) and deliver the rest to matching local sessions.
 * </ul>
 *
 * <p>Known trade-off: the room-capacity check in the handler reads membership and
 * registers in two steps, so simultaneous joins on different nodes can briefly
 * overshoot the cap by a peer or two. Tightening that needs a Lua script; not
 * worth it at the current cap sizes.
 */
@Component
@Profile("redis")
public class RedisBackplane implements Backplane {

    private static final Logger log = LoggerFactory.getLogger(RedisBackplane.class);

    public static final String CHANNEL = "warroom:signal";
    private static final String ROOMS_KEY = "warroom:rooms";
    private static final Duration HEARTBEAT_TTL = Duration.ofSeconds(15);

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final String nodeId = UUID.randomUUID().toString().substring(0, 8);
    private volatile LocalDelivery delivery;

    /** Directory entry stored per member. */
    record MemberEntry(String name, String node) {
    }

    /** Pub/sub envelope. Exactly one of {@code to} / {@code exclude} is set. */
    record Envelope(String origin, String room, String to, String exclude, SignalMessage message) {
    }

    public RedisBackplane(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis = redis;
        this.mapper = mapper;
    }

    public String nodeId() {
        return nodeId;
    }

    @Override
    public void start(LocalDelivery delivery) {
        this.delivery = delivery;
        heartbeat();
        log.info("Redis backplane active, node id {}", nodeId);
    }

    @Scheduled(fixedRate = 5000)
    void heartbeat() {
        redis.opsForValue().set(nodeKey(nodeId), "up", HEARTBEAT_TTL);
    }

    private static String roomKey(String room) {
        return "warroom:room:" + room;
    }

    private static String nodeKey(String node) {
        return "warroom:node:" + node;
    }

    @Override
    public List<PeerInfo> peersIn(String room) {
        Map<Object, Object> raw = redis.opsForHash().entries(roomKey(room));
        List<PeerInfo> peers = new ArrayList<>();
        for (Map.Entry<Object, Object> entry : raw.entrySet()) {
            String peerId = entry.getKey().toString();
            MemberEntry member = readEntry(entry.getValue().toString());
            if (member == null) {
                redis.opsForHash().delete(roomKey(room), peerId);
                continue;
            }
            // Lazy ghost pruning: drop members whose node stopped heartbeating.
            if (!member.node().equals(nodeId) && !Boolean.TRUE.equals(redis.hasKey(nodeKey(member.node())))) {
                log.info("Pruning ghost peer {} (dead node {}) from room {}", peerId, member.node(), room);
                redis.opsForHash().delete(roomKey(room), peerId);
                continue;
            }
            peers.add(new PeerInfo(peerId, member.name()));
        }
        if (peers.isEmpty()) {
            redis.opsForSet().remove(ROOMS_KEY, room);
        }
        return peers;
    }

    @Override
    public void register(String room, String peerId, String name) {
        try {
            redis.opsForHash().put(roomKey(room), peerId,
                    mapper.writeValueAsString(new MemberEntry(name, nodeId)));
            redis.opsForSet().add(ROOMS_KEY, room);
        } catch (Exception e) {
            throw new IllegalStateException("failed to register peer in Redis", e);
        }
    }

    @Override
    public void unregister(String room, String peerId) {
        redis.opsForHash().delete(roomKey(room), peerId);
        if (redis.opsForHash().size(roomKey(room)) == 0) {
            redis.opsForSet().remove(ROOMS_KEY, room);
        }
    }

    @Override
    public Optional<String> nodeOf(String room, String peerId) {
        Object raw = redis.opsForHash().get(roomKey(room), peerId);
        MemberEntry member = raw == null ? null : readEntry(raw.toString());
        return Optional.ofNullable(member).map(MemberEntry::node);
    }

    @Override
    public void publishToPeer(String room, String toPeerId, SignalMessage message) {
        publish(new Envelope(nodeId, room, toPeerId, null, message));
    }

    @Override
    public void publishToRoom(String room, String excludePeerId, SignalMessage message) {
        publish(new Envelope(nodeId, room, null, excludePeerId, message));
    }

    private void publish(Envelope envelope) {
        try {
            redis.convertAndSend(CHANNEL, mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.warn("Failed to publish {} envelope for room {}: {}",
                    envelope.message().type(), envelope.room(), e.getMessage());
        }
    }

    /** Inbound pub/sub frames (wired by {@code RedisConfig}). */
    public void onMessage(String json) {
        Envelope envelope;
        try {
            envelope = mapper.readValue(json, Envelope.class);
        } catch (Exception e) {
            log.warn("Dropping malformed backplane envelope: {}", e.getMessage());
            return;
        }
        if (delivery == null) {
            return;
        }
        if (envelope.to() != null) {
            // Point-to-point: only the node hosting the target has a matching local
            // session; everyone else finds nothing and does nothing.
            delivery.toPeer(envelope.room(), envelope.to(), envelope.message());
        } else if (!nodeId.equals(envelope.origin())) {
            // Broadcast: the origin node already delivered to its own sessions.
            delivery.toRoomExcept(envelope.room(), envelope.exclude(), envelope.message());
        }
    }

    private MemberEntry readEntry(String json) {
        try {
            return mapper.readValue(json, MemberEntry.class);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public int roomCount() {
        Long size = redis.opsForSet().size(ROOMS_KEY);
        return size == null ? 0 : size.intValue();
    }

    @Override
    public int memberCount() {
        Set<String> roomNames = redis.opsForSet().members(ROOMS_KEY);
        if (roomNames == null) {
            return 0;
        }
        int total = 0;
        for (String room : roomNames) {
            total += redis.opsForHash().size(roomKey(room)).intValue();
        }
        return total;
    }
}
