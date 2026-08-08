package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
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
 * <p>The room-capacity decision runs as a Lua script (count + conditional HSET in
 * one atomic step), so simultaneous joins on different nodes cannot overshoot the
 * cap. Ghosts are pruned before the script runs; pruning only ever shrinks the
 * count, so racing prunes stay safe.
 */
@Component
@Profile("redis")
public class RedisBackplane implements Backplane, org.springframework.context.SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(RedisBackplane.class);

    public static final String CHANNEL = "warroom:signal";
    private static final String ROOMS_KEY = "warroom:rooms";
    private static final Duration HEARTBEAT_TTL = Duration.ofSeconds(15);

    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final String nodeId = UUID.randomUUID().toString().substring(0, 8);
    private volatile LocalDelivery delivery;

    /**
     * Directory entry stored per member. {@code subject} is null without an
     * identity provider, and is absent from entries written by an older node —
     * Jackson maps both to null, so a rolling upgrade needs no migration.
     */
    record MemberEntry(String name, String node, String subject) {
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
        // Wiring only — the first Redis command must NOT run here: this is called
        // from a bean constructor, i.e. while the caller holds the bean-factory
        // singleton lock. Lettuce records command latency on its event loop, and
        // the first record triggers the Prometheus exemplar tracer lookup, which
        // needs that same lock — a startup deadlock. First I/O happens in the
        // SmartLifecycle start() below, after singletons are instantiated.
        this.delivery = delivery;
    }

    // SmartLifecycle: first heartbeat after singleton instantiation (lock-free).
    // Phase 0 starts before the web server (Integer.MAX_VALUE - 1), so the node's
    // heartbeat key exists before any join can be registered — otherwise another
    // node could prune this node's members as ghosts in that window.
    private volatile boolean running;

    @Override
    public int getPhase() {
        return 0;
    }

    @Override
    public void start() {
        heartbeat();
        running = true;
        log.info("Redis backplane active, node id {}", nodeId);
    }

    @Override
    public void stop() {
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Scheduled(fixedRate = 5000)
    void heartbeat() {
        redis.opsForValue().set(nodeKey(nodeId), "up", HEARTBEAT_TTL);
    }

    private static String roomKey(String room) {
        return "warroom:room:" + room;
    }

    /** Room meta hash: fields {@code host}, {@code locked} and {@code sfu}; lives with the room. */
    private static String metaKey(String room) {
        return "warroom:roommeta:" + room;
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
            // Ghost pruning can empty a room without an unregister; drop its meta too.
            redis.delete(metaKey(room));
        }
        return peers;
    }

    /**
     * KEYS[1]=room hash, KEYS[2]=rooms set, KEYS[3]=meta hash; ARGV: peerId,
     * entryJson, max, room. Returns the member count after registering, -1 when
     * the room is full, or -2 when it is locked to newcomers. The same atomic
     * step assigns the host: the opener, or a replacement whenever the recorded
     * host is no longer a member.
     */
    private static final DefaultRedisScript<Long> TRY_REGISTER = new DefaultRedisScript<>("""
            if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
              if redis.call('HGET', KEYS[3], 'locked') == '1' then
                return -2
              end
              if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
                return -1
              end
            end
            redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
            redis.call('SADD', KEYS[2], ARGV[4])
            local host = redis.call('HGET', KEYS[3], 'host')
            if not host or redis.call('HEXISTS', KEYS[1], host) == 0 then
              redis.call('HSET', KEYS[3], 'host', ARGV[1])
            end
            return redis.call('HLEN', KEYS[1])
            """, Long.class);

    /**
     * KEYS[1]=room hash, KEYS[2]=rooms set, KEYS[3]=meta hash; ARGV: peerId,
     * room. Returns members left. The last leave deletes the meta (lock and host
     * die with the room); a departing host hands the role to a remaining member.
     */
    private static final DefaultRedisScript<Long> UNREGISTER = new DefaultRedisScript<>("""
            redis.call('HDEL', KEYS[1], ARGV[1])
            local remaining = redis.call('HLEN', KEYS[1])
            if remaining == 0 then
              redis.call('SREM', KEYS[2], ARGV[2])
              redis.call('DEL', KEYS[3])
              return remaining
            end
            local host = redis.call('HGET', KEYS[3], 'host')
            if not host or redis.call('HEXISTS', KEYS[1], host) == 0 then
              local members = redis.call('HKEYS', KEYS[1])
              redis.call('HSET', KEYS[3], 'host', members[1])
            end
            return remaining
            """, Long.class);

    @Override
    public int tryRegister(String room, String peerId, String name, String subject, int maxRoomSize) {
        try {
            Long result = redis.execute(TRY_REGISTER,
                    List.of(roomKey(room), ROOMS_KEY, metaKey(room)),
                    peerId,
                    mapper.writeValueAsString(new MemberEntry(name, nodeId, subject)),
                    String.valueOf(maxRoomSize),
                    room);
            return result == null ? REGISTER_REJECTED : result.intValue();
        } catch (Exception e) {
            throw new IllegalStateException("failed to register peer in Redis", e);
        }
    }

    @Override
    public int unregister(String room, String peerId) {
        Long remaining = redis.execute(UNREGISTER,
                List.of(roomKey(room), ROOMS_KEY, metaKey(room)), peerId, room);
        return remaining == null ? 0 : remaining.intValue();
    }

    @Override
    public RoomState roomState(String room) {
        Map<Object, Object> meta = redis.opsForHash().entries(metaKey(room));
        if (meta.isEmpty()) {
            return RoomState.EMPTY;
        }
        Object host = meta.get("host");
        return new RoomState(host == null ? null : host.toString(),
                "1".equals(meta.get("locked")), "1".equals(meta.get("sfu")));
    }

    @Override
    public void markSfu(String room) {
        // A plain HSET rather than part of the register script: the field only
        // ever goes from unset to 1, so two nodes racing to set it agree.
        redis.opsForHash().put(metaKey(room), "sfu", "1");
    }

    @Override
    public void setLocked(String room, boolean locked) {
        redis.opsForHash().put(metaKey(room), "locked", locked ? "1" : "0");
    }

    @Override
    public Optional<String> nodeOf(String room, String peerId) {
        return entryOf(room, peerId).map(MemberEntry::node);
    }

    @Override
    public Optional<String> subjectOf(String room, String peerId) {
        return entryOf(room, peerId).map(MemberEntry::subject);
    }

    private Optional<MemberEntry> entryOf(String room, String peerId) {
        Object raw = redis.opsForHash().get(roomKey(room), peerId);
        return Optional.ofNullable(raw == null ? null : readEntry(raw.toString()));
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
