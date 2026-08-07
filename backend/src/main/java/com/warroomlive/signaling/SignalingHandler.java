package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.chat.ChatRepository;
import com.warroomlive.chat.StoredMessage;
import com.warroomlive.events.OutboxRecorder;
import com.warroomlive.limits.RateLimiter;
import com.warroomlive.meetings.MeetingTracker;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.springframework.beans.factory.ObjectProvider;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * WebSocket endpoint that relays WebRTC signaling between peers sharing a room.
 *
 * <p>The server never touches media; it only forwards SDP offers/answers and ICE
 * candidates to the addressed peer, and broadcasts membership changes. Peers form a
 * full mesh, so each pair negotiates directly.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);

    /** Buffer/time limits before a slow client's session is force-closed by the decorator. */
    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 512 * 1024;

    private final RoomManager rooms;
    private final Backplane backplane;
    private final ObjectMapper mapper;
    private final ChatRepository chat;
    /** Present only under the kafka profile; membership events are skipped without it. */
    private final ObjectProvider<OutboxRecorder> outbox;
    /** Present only under the postgres profile; meetings go untracked without it. */
    private final ObjectProvider<MeetingTracker> meetings;
    private final int maxRoomSize;
    private final int historyLimit;
    private final int maxChatLength;
    private final RateLimiter rateLimiter;

    /** Wraps raw sessions so concurrent sends from multiple peers are serialized safely. */
    private final Map<String, ConcurrentWebSocketSessionDecorator> safeSessions = new ConcurrentHashMap<>();

    private final MeterRegistry metrics;
    private final AtomicInteger connectionsActive = new AtomicInteger();
    private final Timer processingTimer;

    public SignalingHandler(
            RoomManager rooms,
            Backplane backplane,
            ObjectMapper mapper,
            ChatRepository chat,
            ObjectProvider<OutboxRecorder> outbox,
            ObjectProvider<MeetingTracker> meetings,
            MeterRegistry metrics,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.signaling.max-room-size:8}") int maxRoomSize,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.chat.history-limit:100}") int historyLimit,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.signaling.max-messages-per-second:60}") int maxMessagesPerSecond,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.chat.max-length:4000}") int maxChatLength) {
        this.rooms = rooms;
        this.backplane = backplane;
        this.mapper = mapper;
        this.chat = chat;
        this.outbox = outbox;
        this.meetings = meetings;
        this.metrics = metrics;
        this.maxRoomSize = maxRoomSize;
        this.historyLimit = historyLimit;
        this.maxChatLength = maxChatLength;
        this.rateLimiter = new RateLimiter(maxMessagesPerSecond);
        metrics.gauge("warroomlive.signaling.connections.active", connectionsActive);
        this.processingTimer = Timer.builder("warroomlive.signaling.message.processing")
                .description("Time spent handling one inbound signaling message")
                .register(metrics);
        // Deliver backplane traffic from other nodes into this node's sessions.
        backplane.start(new Backplane.LocalDelivery() {
            @Override
            public void toPeer(String room, String peerId, SignalMessage message) {
                // A kick may originate on another node; the node hosting the target
                // must also close the connection, not just deliver the notice.
                if (SignalMessage.TYPE_KICKED.equals(message.type())) {
                    rooms.session(room, peerId).ifPresent(s -> deliverKickAndClose(s, message));
                    return;
                }
                rooms.session(room, peerId).ifPresent(s -> send(s, message));
            }

            @Override
            public void toRoomExcept(String room, String excludePeerId, SignalMessage message) {
                rooms.othersIn(room, excludePeerId).forEach(s -> send(s, message));
            }
        });
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        safeSessions.put(session.getId(), new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES));
        connectionsActive.incrementAndGet();
        log.debug("WebSocket connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        processingTimer.record(() -> handleParsedMessage(session, message));
    }

    private void handleParsedMessage(WebSocketSession session, TextMessage message) {
        // Per-message credential check (oidc mode): a connection whose handshake
        // token has expired is closed — the client must reconnect with a renewed
        // token. 4401 mirrors HTTP 401 in the private close-code range.
        Object expiry = session.getAttributes().get(com.warroomlive.config.WebSocketConfig.TOKEN_EXPIRY_ATTRIBUTE);
        if (expiry instanceof Long expiresAtMillis && System.currentTimeMillis() > expiresAtMillis) {
            log.info("Closing session {}: handshake token expired", session.getId());
            countIn("token-expired");
            try {
                session.close(new CloseStatus(4401, "access token expired"));
            } catch (IOException e) {
                log.warn("Failed to close expired session {}: {}", session.getId(), e.getMessage());
            }
            return;
        }
        // Rate limit before parsing: a flood costs as little as possible, and the
        // message is dropped rather than closing the connection — a burst is far
        // more often a bug or a bad network than an attack, and disconnecting the
        // whole session would take chat, presence and negotiation down with it.
        // Sustained abuse simply keeps losing messages, and shows up in metrics.
        if (!rateLimiter.tryConsume(session.getId())) {
            countIn("rate-limited");
            return;
        }
        SignalMessage msg;
        try {
            msg = mapper.readValue(message.getPayload(), SignalMessage.class);
        } catch (Exception e) {
            log.warn("Dropping malformed signaling message from {}: {}", session.getId(), e.getMessage());
            countIn("malformed");
            sendError(session, null, "malformed message");
            return;
        }

        if (msg.type() == null) {
            countIn("malformed");
            sendError(session, null, "missing message type");
            return;
        }

        switch (msg.type()) {
            case SignalMessage.TYPE_JOIN -> handleJoin(session, msg);
            case SignalMessage.TYPE_OFFER, SignalMessage.TYPE_ANSWER, SignalMessage.TYPE_CANDIDATE ->
                    relayToPeer(session, msg);
            case SignalMessage.TYPE_CHAT -> handleChat(session, msg);
            case SignalMessage.TYPE_STATE, SignalMessage.TYPE_REACTION, SignalMessage.TYPE_HAND ->
                    broadcastToRoom(session, msg);
            case SignalMessage.TYPE_LOCK -> handleLock(session, msg);
            case SignalMessage.TYPE_KICK -> handleKick(session, msg);
            case SignalMessage.TYPE_LEAVE -> handleLeave(session);
            default -> {
                countIn("unsupported");
                sendError(session, msg.room(), "unsupported message type: " + msg.type());
                return;
            }
        }
        countIn(msg.type());
    }

    /** The inbound type tag is bounded: known protocol types plus malformed/unsupported. */
    private void countIn(String type) {
        metrics.counter("warroomlive.signaling.messages.in", "type", type).increment();
    }

    private void handleJoin(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from())) {
            sendError(session, msg.room(), "join requires 'room' and 'from'");
            return;
        }

        // Read the (ghost-pruned) membership for the peers reply, then let the
        // backplane make the capacity decision atomically — reconnects of an
        // existing member always pass.
        List<PeerInfo> clusterPeers = backplane.peersIn(msg.room());
        String name = displayName(msg);
        int memberCount = backplane.tryRegister(msg.room(), msg.from(), name, maxRoomSize);
        if (memberCount == Backplane.REGISTER_REJECTED) {
            log.info("Rejected {} from full room {} (cap {})", msg.from(), msg.room(), maxRoomSize);
            send(session, new SignalMessage(
                    SignalMessage.TYPE_ROOM_FULL, msg.room(), null, msg.from(),
                    mapper.valueToTree(maxRoomSize)));
            // Access-control decisions are audit-relevant: emit the rejection.
            outbox.ifAvailable(recorder -> recorder.record(
                    "participant.rejected", "room", msg.room(),
                    Map.of("peerId", msg.from(), "reason", "room_full", "capacity", maxRoomSize)));
            return;
        }
        if (memberCount == Backplane.REGISTER_LOCKED) {
            log.info("Rejected {} from locked room {}", msg.from(), msg.room());
            send(session, new SignalMessage(
                    SignalMessage.TYPE_ROOM_LOCKED, msg.room(), null, msg.from(), null));
            outbox.ifAvailable(recorder -> recorder.record(
                    "participant.rejected", "room", msg.room(),
                    Map.of("peerId", msg.from(), "reason", "room_locked")));
            return;
        }

        rooms.join(msg.room(), msg.from(), name, session);
        meetings.ifAvailable(tracker -> tracker.participantJoined(msg.room(), memberCount));
        List<PeerInfo> existingPeers = clusterPeers.stream()
                .filter(info -> !info.id().equals(msg.from()))
                .toList();
        log.info("Peer {} ({}) joined room {} ({} existing peer(s))",
                msg.from(), name, msg.room(), existingPeers.size());

        // Tell the newcomer who is already here (id + name) so it can initiate offers.
        send(session, new SignalMessage(
                SignalMessage.TYPE_PEERS, msg.room(), null, msg.from(),
                mapper.valueToTree(existingPeers)));

        // Tell the newcomer the room's meta state (who hosts, locked flag).
        send(session, roomStateMessage(msg.room(), backplane.roomState(msg.room())));

        // Replay the room's recent chat so a refreshed or newly-joined peer has context.
        List<StoredMessage> history = chat.recent(msg.room(), historyLimit);
        if (!history.isEmpty()) {
            send(session, new SignalMessage(
                    SignalMessage.TYPE_HISTORY, msg.room(), null, msg.from(),
                    mapper.valueToTree(history)));
        }

        // Tell everyone else that a new peer arrived, carrying its display name.
        SignalMessage joined = new SignalMessage(
                SignalMessage.TYPE_PEER_JOINED, msg.room(), msg.from(), null,
                mapper.valueToTree(name));
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, joined));
        backplane.publishToRoom(msg.room(), msg.from(), joined);
        outbox.ifAvailable(recorder -> recorder.record(
                "participant.joined", "room", msg.room(), Map.of("peerId", msg.from(), "name", name)));
    }

    private void relayToPeer(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.to()) || isBlank(msg.from())) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'to'");
            return;
        }
        Optional<WebSocketSession> target = rooms.session(msg.room(), msg.to());
        if (target.isPresent()) {
            send(target.get(), msg);
            return;
        }
        // Not on this node: route via the backplane if the directory knows the peer.
        if (backplane.nodeOf(msg.room(), msg.to()).isPresent()) {
            backplane.publishToPeer(msg.room(), msg.to(), msg);
            return;
        }
        sendError(session, msg.room(), "peer not found: " + msg.to());
    }

    /** Persists a chat message, then fans it out to everyone else in the room. */
    private void handleChat(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null) {
            sendError(session, msg.room(), "chat requires 'room', 'from' and 'payload'");
            return;
        }
        // A chat message is the one signaling payload that lands in durable
        // storage, so it is bounded here rather than being allowed to define its
        // own size. Rejecting tells the sender their message did not go through;
        // silently truncating would be worse, because they would believe it did.
        String text = msg.payload().asText();
        if (text.length() > maxChatLength) {
            countIn("chat-too-long");
            sendError(session, msg.room(),
                    "chat message exceeds " + maxChatLength + " characters");
            return;
        }
        String name = rooms.nameOf(msg.room(), msg.from()).orElse(msg.from());
        chat.append(msg.room(), new StoredMessage(
                msg.from(), name, text, System.currentTimeMillis()));
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, msg));
        backplane.publishToRoom(msg.room(), msg.from(), msg);
    }

    /** Fans an ephemeral message (media state, reaction, hand) out to the rest of the room. */
    private void broadcastToRoom(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'payload'");
            return;
        }
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, msg));
        backplane.publishToRoom(msg.room(), msg.from(), msg);
    }

    /**
     * Privileged sender check: the message's claimed {@code from} must be the
     * peer this session joined as, and that peer must currently host the room.
     * Returns the acting host's id, or empty after sending the caller an error.
     */
    private Optional<String> requireHost(WebSocketSession session, SignalMessage msg) {
        Optional<RoomManager.PeerLocation> location = rooms.locationOf(session);
        if (location.isEmpty()
                || !location.get().room().equals(msg.room())
                || !location.get().peerId().equals(msg.from())) {
            sendError(session, msg.room(), msg.type() + " sender does not match this connection");
            return Optional.empty();
        }
        Backplane.RoomState state = backplane.roomState(msg.room());
        if (!msg.from().equals(state.hostId())) {
            sendError(session, msg.room(), "only the host can " + msg.type());
            return Optional.empty();
        }
        return Optional.of(msg.from());
    }

    /** Host locks or unlocks the room to newcomers; everyone gets the new room-state. */
    private void handleLock(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null || !msg.payload().isBoolean()) {
            sendError(session, msg.room(), "lock requires 'room', 'from' and a boolean 'payload'");
            return;
        }
        if (requireHost(session, msg).isEmpty()) {
            return;
        }
        boolean locked = msg.payload().asBoolean();
        backplane.setLocked(msg.room(), locked);
        log.info("Room {} {} by host {}", msg.room(), locked ? "locked" : "unlocked", msg.from());
        SignalMessage state = roomStateMessage(msg.room(), backplane.roomState(msg.room()));
        rooms.othersIn(msg.room(), null).forEach(other -> send(other, state));
        backplane.publishToRoom(msg.room(), null, state);
        outbox.ifAvailable(recorder -> recorder.record(
                locked ? "room.locked" : "room.unlocked", "room", msg.room(),
                Map.of("by", msg.from())));
    }

    /** Host removes the peer named in {@code to}; its connection is closed with 4403. */
    private void handleKick(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || isBlank(msg.to())) {
            sendError(session, msg.room(), "kick requires 'room', 'from' and 'to'");
            return;
        }
        if (msg.to().equals(msg.from())) {
            sendError(session, msg.room(), "the host cannot kick itself");
            return;
        }
        if (requireHost(session, msg).isEmpty()) {
            return;
        }
        SignalMessage kicked = new SignalMessage(
                SignalMessage.TYPE_KICKED, msg.room(), null, msg.to(), mapper.valueToTree(msg.from()));
        Optional<WebSocketSession> target = rooms.session(msg.room(), msg.to());
        if (target.isPresent()) {
            deliverKickAndClose(target.get(), kicked);
        } else if (backplane.nodeOf(msg.room(), msg.to()).isPresent()) {
            // Hosted elsewhere: the target's node delivers the notice and closes.
            backplane.publishToPeer(msg.room(), msg.to(), kicked);
        } else {
            sendError(session, msg.room(), "peer not found: " + msg.to());
            return;
        }
        log.info("Peer {} kicked from room {} by host {}", msg.to(), msg.room(), msg.from());
        outbox.ifAvailable(recorder -> recorder.record(
                "participant.kicked", "room", msg.room(),
                Map.of("peerId", msg.to(), "by", msg.from())));
    }

    /**
     * Sends the kicked notice, then closes the connection (4403 mirrors HTTP 403).
     * Membership cleanup and the peer-left broadcast ride the close path.
     */
    private void deliverKickAndClose(WebSocketSession session, SignalMessage kicked) {
        send(session, kicked);
        try {
            session.close(new CloseStatus(4403, "removed by host"));
        } catch (IOException e) {
            log.warn("Failed to close kicked session {}: {}", session.getId(), e.getMessage());
        }
    }

    private SignalMessage roomStateMessage(String room, Backplane.RoomState state) {
        return new SignalMessage(SignalMessage.TYPE_ROOM_STATE, room, null, null,
                mapper.valueToTree(Map.of(
                        "host", state.hostId() == null ? "" : state.hostId(),
                        "locked", state.locked())));
    }

    private void handleLeave(WebSocketSession session) {
        rooms.remove(session).ifPresent(location -> broadcastPeerLeft(location));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        safeSessions.remove(session.getId());
        rateLimiter.release(session.getId());
        connectionsActive.decrementAndGet();
        rooms.remove(session).ifPresent(this::broadcastPeerLeft);
        log.debug("WebSocket closed: {} ({})", session.getId(), status);
    }

    private void broadcastPeerLeft(RoomManager.PeerLocation location) {
        log.info("Peer {} left room {}", location.peerId(), location.room());
        int remaining = backplane.unregister(location.room(), location.peerId());
        SignalMessage left = new SignalMessage(
                SignalMessage.TYPE_PEER_LEFT, location.room(), location.peerId(), null, null);
        rooms.othersIn(location.room(), location.peerId()).forEach(other -> send(other, left));
        backplane.publishToRoom(location.room(), location.peerId(), left);
        if (remaining > 0) {
            // The departing peer may have been the host; re-broadcast the (possibly
            // handed-over) room state so everyone agrees on who hosts now.
            SignalMessage state = roomStateMessage(
                    location.room(), backplane.roomState(location.room()));
            rooms.othersIn(location.room(), location.peerId()).forEach(other -> send(other, state));
            backplane.publishToRoom(location.room(), location.peerId(), state);
        }
        outbox.ifAvailable(recorder -> recorder.record(
                "participant.left", "room", location.room(), Map.of("peerId", location.peerId())));
        meetings.ifAvailable(tracker -> tracker.participantLeft(location.room(), remaining));
    }

    private void sendError(WebSocketSession session, String room, String reason) {
        send(session, new SignalMessage(
                SignalMessage.TYPE_ERROR, room, null, null, mapper.valueToTree(reason)));
    }

    private void send(WebSocketSession session, SignalMessage message) {
        // Only ever write through the concurrency decorator. If it is already gone
        // (session mid-close), drop the message — falling back to the raw session
        // would interleave frames from multiple threads (TEXT_PARTIAL_WRITING).
        WebSocketSession sink = safeSessions.get(session.getId());
        if (sink == null || !sink.isOpen()) {
            return;
        }
        try {
            sink.sendMessage(new TextMessage(mapper.writeValueAsString(message)));
            metrics.counter("warroomlive.signaling.messages.out", "type", message.type()).increment();
        } catch (IOException | IllegalStateException e) {
            // IllegalStateException = the session closed between the isOpen check
            // and the write. Both are per-recipient races; they must never
            // propagate, or the *sender's* connection gets torn down with 1011.
            log.debug("Dropped {} to closing session {}: {}",
                    message.type(), session.getId(), e.getMessage());
        }
    }

    /** Extracts a trimmed display name from a join payload, falling back to the peer id. */
    private static String displayName(SignalMessage msg) {
        if (msg.payload() != null && msg.payload().isTextual()) {
            String name = msg.payload().asText().trim();
            if (!name.isEmpty()) {
                return name;
            }
        }
        return msg.from();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
